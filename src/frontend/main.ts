import type {
    InterfaceMetrics,
    LinkDefinition,
    LinkMetrics,
    MetricsPayload,
    Position,
    RouterDefinition,
    RouterMetrics,
    ServerMessage,
    TopologyDefinition
} from "../shared/types.js";

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false });
const hud = document.querySelector("#hud") as HTMLElement;
const sidebarPeekButton = document.querySelector("#sidebar-peek") as HTMLButtonElement | null;

if (!canvas || !ctx || !hud || !sidebarPeekButton) {
    throw new Error("Expected canvas, HUD, and sidebar toggle elements to exist");
}

type RenderState = {
    baseWidth: number;
    baseHeight: number;
    scale: number;
    dpr: number;
};

const renderState: RenderState = {
    baseWidth: window.innerWidth,
    baseHeight: window.innerHeight,
    scale: 1,
    dpr: window.devicePixelRatio || 1
};

let topology: TopologyDefinition | null = null;
let metrics: MetricsPayload | null = null;
let linkCapacityMap = new Map<string, number | null>();
let capacityRange: { min: number; max: number } | null = null;
let linkPathMap = new Map<string, Position[]>();
let layoutMode = false;

const pointerState: {
    dragging: boolean;
    routerId: string | null;
    pointerId: number | null;
    offset: Position | null;
} = {
    dragging: false,
    routerId: null,
    pointerId: null,
    offset: null
};

const backgroundImage = new Image();
let backgroundLoaded = false;

const roundedRect = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
) => {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
};

backgroundImage.onload = () => {
    backgroundLoaded = true;
    draw();
};
backgroundImage.onerror = () => {
    backgroundLoaded = false;
    draw();
};

const UTILIZATION_BUCKETS = [
    { min: 0, max: 0.01, color: "#0ea5e9", label: "0-1%" },
    { min: 0.01, max: 0.2, color: "#22c55e", label: "1-20%" },
    { min: 0.2, max: 0.4, color: "#84cc16", label: "20-40%" },
    { min: 0.4, max: 0.6, color: "#facc15", label: "40-60%" },
    { min: 0.6, max: 0.8, color: "#f97316", label: "60-80%" },
    { min: 0.8, max: 0.9, color: "#ea580c", label: "80-90%" },
    { min: 0.9, max: 0.99, color: "#ef4444", label: "90-99%" },
    { min: 0.99, max: 1.01, color: "#991b1b", label: "99-100%" }
] as const;

const utilToColor = (utilization: number | null): string => {
    if (utilization === null || Number.isNaN(utilization)) {
        return "#5a646d";
    }
    const bucket =
        UTILIZATION_BUCKETS.find(range => utilization >= range.min && utilization < range.max) ?? UTILIZATION_BUCKETS[UTILIZATION_BUCKETS.length - 1];
    return bucket.color;
};

const formatPercent = (value: number | null | undefined): string => {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "—";
    }
    return `${Math.round(value * 1000) / 10}%`;
};

const formatThroughput = (bps: number | null | undefined): string => {
    if (!bps || Number.isNaN(bps) || bps <= 0) {
        return "0 bps";
    }

    const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    let value = bps;
    let unitIndex = 0;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex += 1;
    }

    const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const renderUtilBar = (utilization: number | null): string => {
    const clamped = utilization !== null && utilization !== undefined ? Math.max(0, Math.min(1, utilization)) : 0;
    const percent = Math.round(clamped * 100);
    const color = utilToColor(utilization ?? null);
    return `<div class="util-bar"><span class="util-bar-fill" style="width:${percent}%;background:${color}"></span></div>`;
};

const buildRouterMap = (routers: RouterDefinition[]) => {
    const map = new Map<string, RouterDefinition>();
    routers.forEach(router => map.set(router.id, router));
    return map;
};

const rebuildLinkCapacities = () => {
    if (!topology) return;
    const routerMap = buildRouterMap(topology.routers);
    const capacities: number[] = [];
    const map = new Map<string, number | null>();

    topology.links.forEach(link => {
        const forwardRouter = routerMap.get(link.from);
        const reverseRouter = routerMap.get(link.to);

        const forwardCapacity =
            forwardRouter?.interfaces.find(iface => iface.name === link.ifaceFrom)?.maxBandwidth ?? null;
        const reverseCapacity =
            reverseRouter?.interfaces.find(iface => iface.name === link.ifaceTo)?.maxBandwidth ?? null;

        const candidates = [forwardCapacity, reverseCapacity].filter(
            (value): value is number => typeof value === "number" && value > 0
        );
        const capacity = candidates.length ? Math.min(...candidates) : null;
        if (capacity) {
            capacities.push(capacity);
        }
        map.set(link.id, capacity);
    });

    linkCapacityMap = map;
    capacityRange = capacities.length ? { min: Math.min(...capacities), max: Math.max(...capacities) } : null;
};

const computeAutoPath = (
    from: Position,
    to: Position,
    groupSize: number,
    index: number
): Position[] => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const midpoint = { x: from.x + dx / 2, y: from.y + dy / 2 };
    const normalizedPerp = { x: -dy / length, y: dx / length };
    const spacing = Math.min(160, Math.max(40, length / 3));
    const offset = (index - (groupSize - 1) / 2) * spacing;
    const control = {
        x: midpoint.x + normalizedPerp.x * offset,
        y: midpoint.y + normalizedPerp.y * offset
    };

    if (groupSize === 1 || Math.abs(offset) < 1) {
        return [from, to];
    }
    return [from, control, to];
};

const rebuildLinkPaths = () => {
    if (!topology) return;
    const routerMap = buildRouterMap(topology.routers);
    const manualPaths = new Map<string, Position[]>();

    topology.links.forEach(link => {
        if (!link.path || link.path.length === 0) return;
        const fromRouter = routerMap.get(link.from);
        const toRouter = routerMap.get(link.to);
        if (!fromRouter || !toRouter) return;
        const points = [
            fromRouter.position,
            ...link.path.map(point => ({ x: point.x, y: point.y })),
            toRouter.position
        ];
        manualPaths.set(link.id, points);
    });

    const groupMap = new Map<string, LinkDefinition[]>();
    topology.links.forEach(link => {
        const key = [link.from, link.to].sort().join("::");
        const group = groupMap.get(key) ?? [];
        group.push(link);
        groupMap.set(key, group);
    });

    const paths = new Map<string, Position[]>();

    groupMap.forEach(group => {
        group.sort((a, b) => a.id.localeCompare(b.id));
        group.forEach((link, index) => {
            if (manualPaths.has(link.id)) {
                paths.set(link.id, manualPaths.get(link.id)!);
                return;
            }
            const fromRouter = routerMap.get(link.from);
            const toRouter = routerMap.get(link.to);
            if (!fromRouter || !toRouter) return;
            paths.set(link.id, computeAutoPath(fromRouter.position, toRouter.position, group.length, index));
        });
    });

    // Include any manual paths that reference unmatched routers
    manualPaths.forEach((path, id) => {
        if (!paths.has(id)) {
            paths.set(id, path);
        }
    });

    linkPathMap = paths;
};

const resizeCanvas = () => {
    if (!topology) return;

    const baseWidth = topology.mapSize?.width ?? window.innerWidth;
    const baseHeight = topology.mapSize?.height ?? window.innerHeight;
    const availableWidth = window.innerWidth;
    const availableHeight = window.innerHeight;
    const scale = topology.mapSize ? Math.min(availableWidth / baseWidth, availableHeight / baseHeight) : 1;
    const width = baseWidth * scale;
    const height = baseHeight * scale;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    renderState.baseWidth = baseWidth;
    renderState.baseHeight = baseHeight;
    renderState.scale = scale;
    renderState.dpr = dpr;
};

const drawBackground = () => {
    if (backgroundLoaded) {
        ctx.drawImage(backgroundImage, 0, 0, renderState.baseWidth, renderState.baseHeight);
    } else {
        const gradient = ctx.createLinearGradient(0, 0, renderState.baseWidth, renderState.baseHeight);
        gradient.addColorStop(0, "#0b1120");
        gradient.addColorStop(1, "#111827");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, renderState.baseWidth, renderState.baseHeight);
    }
};

const getPathMidpoint = (path: Position[]): Position => {
    if (path.length === 0) {
        return { x: 0, y: 0 };
    }
    if (path.length === 2) {
        return {
            x: (path[0].x + path[1].x) / 2,
            y: (path[0].y + path[1].y) / 2
        };
    }
    return path[Math.floor(path.length / 2)];
};

const drawPathStroke = (path: Position[]) => {
    if (path.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    if (path.length === 2) {
        ctx.lineTo(path[1].x, path[1].y);
    } else {
        for (let i = 1; i < path.length - 1; i++) {
            const current = path[i];
            const next = path[i + 1];
            const midX = (current.x + next.x) / 2;
            const midY = (current.y + next.y) / 2;
            ctx.quadraticCurveTo(current.x, current.y, midX, midY);
        }
        ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y);
    }
    ctx.stroke();
};

const screenToMap = (clientX: number, clientY: number): Position => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const xPx = (clientX - rect.left) * scaleX;
    const yPx = (clientY - rect.top) * scaleY;
    const transform = renderState.dpr * renderState.scale;
    return {
        x: xPx / transform,
        y: yPx / transform
    };
};

const MIN_LINK_WIDTH = 2;
const MAX_LINK_WIDTH = 14;

const capacityToWidth = (capacity: number | null): number => {
    if (!capacity || !capacityRange) {
        return MIN_LINK_WIDTH;
    }
    const { min, max } = capacityRange;
    if (capacity <= 0 || min <= 0) {
        return MIN_LINK_WIDTH;
    }
    if (max === min) {
        return (MIN_LINK_WIDTH + MAX_LINK_WIDTH) / 2;
    }
    const logMin = Math.log(min);
    const logMax = Math.log(max);
    const logValue = Math.log(capacity);
    const t = Math.min(1, Math.max(0, (logValue - logMin) / (logMax - logMin)));
    return MIN_LINK_WIDTH + (MAX_LINK_WIDTH - MIN_LINK_WIDTH) * t;
};

const drawLink = (
    path: Position[],
    utilization: number | null,
    capacity: number | null,
    label?: string
) => {
    if (path.length < 2) return;
    const color = utilToColor(utilization);
    const width = capacityToWidth(capacity);

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawPathStroke(path);

    if (label) {
        const midpoint = getPathMidpoint(path);
        ctx.save();
        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = 1;
        ctx.font = "12px 'Inter', 'Segoe UI', sans-serif";
        const padding = 6;
        const metrics = ctx.measureText(label);
        const boxWidth = metrics.width + padding * 2;
        const boxHeight = 18;
        roundedRect(ctx, midpoint.x - boxWidth / 2, midpoint.y - boxHeight / 2, boxWidth, boxHeight, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(label, midpoint.x - metrics.width / 2, midpoint.y + 4);
        ctx.restore();
    }
};

let sidebarVisible = true;

const updateSidebarVisibility = () => {
    if (sidebarVisible) {
        hud.removeAttribute("aria-hidden");
        hud.classList.remove("hidden");
    } else {
        hud.setAttribute("aria-hidden", "true");
        hud.classList.add("hidden");
    }

    const arrow = sidebarVisible ? "❯" : "❮";
    sidebarPeekButton.textContent = arrow;
    sidebarPeekButton.setAttribute("aria-label", sidebarVisible ? "Hide sidebar" : "Show sidebar");
    sidebarPeekButton.setAttribute("aria-pressed", String(!sidebarVisible));
};

updateSidebarVisibility();

const drawRouter = (router: RouterDefinition, metric: RouterMetrics | null) => {
    const status = metric?.status ?? "error";
    const colorMap: Record<typeof status, string> = {
        ok: "#22c55e",
        warning: "#f97316",
        critical: "#ef4444",
        error: "#f87171"
    };

    ctx.save();
    ctx.shadowColor = "rgba(30, 64, 175, 0.25)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = colorMap[status] ?? "#f87171";
    ctx.beginPath();
    ctx.arc(router.position.x, router.position.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
    ctx.lineWidth = 1;
    ctx.font = "12px 'Inter', 'Segoe UI', sans-serif";
    const label = router.label;
    const padding = 6;
    const metrics = ctx.measureText(label);
    const boxWidth = metrics.width + padding * 2;
    const boxHeight = 20;
    const x = router.position.x - boxWidth / 2;
    const y = router.position.y + 18;
    roundedRect(ctx, x, y, boxWidth, boxHeight, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(label, router.position.x - metrics.width / 2, y + 14);
    ctx.restore();
};

const draw = () => {
    if (!topology) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    const transformScale = renderState.dpr * renderState.scale;
    ctx.save();
    ctx.setTransform(transformScale, 0, 0, transformScale, 0, 0);

    drawBackground();

    const routerMap = new Map<string, RouterDefinition>();
    topology.routers.forEach(router => routerMap.set(router.id, router));

    const linkMetricsMap = new Map<string, LinkMetrics>();
    metrics?.links.forEach(link => linkMetricsMap.set(link.id, link));

    topology.links.forEach(link => {
        const fromRouter = routerMap.get(link.from);
        const toRouter = routerMap.get(link.to);
        if (!fromRouter || !toRouter) return;
        const metric = linkMetricsMap.get(link.id);
        const utilization = metric?.aggregateUtilization ?? null;
        const label = metric?.label ?? link.label;
        const capacity = linkCapacityMap.get(link.id) ?? null;
        const path = linkPathMap.get(link.id) ?? [fromRouter.position, toRouter.position];
        drawLink(path, utilization, capacity, label);
    });

    topology.routers.forEach(router => {
        const routerMetrics = metrics?.routers[router.id] ?? null;
        drawRouter(router, routerMetrics);
    });

    if (layoutMode) {
        topology.routers.forEach(router => {
            ctx.save();
            ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
            ctx.setLineDash([6, 6]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(router.position.x, router.position.y, 20, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        });
    }

    ctx.restore();
};

const renderHud = () => {
    if (!topology) {
        hud.innerHTML = `<div class="hud-empty">Loading topology…</div>`;
        updateSidebarVisibility();
        return;
    }

    const lastUpdated = metrics ? new Date(metrics.timestamp).toLocaleTimeString() : "Waiting for data…";
    const linkRanking = metrics
        ? [...metrics.links].sort((a, b) => (b.aggregateUtilization ?? 0) - (a.aggregateUtilization ?? 0)).slice(0, 5)
        : [];

    const linkList = linkRanking.length
        ? linkRanking
              .map(
                  link =>
                      `<li><span>${link.label ?? `${link.from} → ${link.to}`}</span><span class="metric">${formatPercent(link.aggregateUtilization)}</span></li>`
              )
              .join("")
        : `<li>No link telemetry yet.</li>`;

    const routerCards = topology.routers
        .map(router => {
            const routerMetrics: RouterMetrics | null = metrics?.routers[router.id] ?? null;
            const status = routerMetrics?.status ?? "error";

            const interfacesRows = router.interfaces
                .map(iface => {
                    const ifaceMetrics: InterfaceMetrics | undefined = routerMetrics?.interfaces[iface.name];
                    const utilisation =
                        ifaceMetrics && Number.isFinite(Math.max(ifaceMetrics.inUtilization, ifaceMetrics.outUtilization))
                            ? Math.max(ifaceMetrics.inUtilization, ifaceMetrics.outUtilization)
                            : null;
                    return `<div class="iface-row">
    <div class="iface-name">${iface.displayName ?? iface.name}</div>
    <div class="iface-bars">
        ${renderUtilBar(utilisation)}
    </div>
    <div class="iface-metrics">
        <span class="metric up">⬆ ${formatThroughput(ifaceMetrics?.outBps)}</span>
        <span class="metric down">⬇ ${formatThroughput(ifaceMetrics?.inBps)}</span>
    </div>
    ${ifaceMetrics?.error ? `<div class="iface-error">${ifaceMetrics.error}</div>` : ""}
</div>`;
                })
                .join("");

            const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
            return `<section class="router-card status-${status}">
    <header>
        <h3>${router.label}</h3>
        <span class="status-pill">${statusLabel}</span>
    </header>
    <div class="router-body">
        ${interfacesRows}
    </div>
    ${routerMetrics?.error ? `<p class="router-error">${routerMetrics.error}</p>` : ""}
</section>`;
        })
        .join("");

    hud.innerHTML = `<header class="hud-header">
    <div>
        <h1>${topology.title ?? "TS Weathermap"}</h1>
        <p class="hud-subtitle">Last updated ${lastUpdated}</p>
    </div>
    <div class="hud-legend">
        ${UTILIZATION_BUCKETS.map(
            bucket => `<span class="legend-item"><span class="legend-dot" style="background:${bucket.color}"></span>${bucket.label}</span>`
        ).join("")}
    </div>
    <div class="hud-actions">
        <button class="layout-toggle ${layoutMode ? "active" : ""}" data-action="toggle-layout">${layoutMode ? "Exit Layout Mode" : "Layout Mode"}</button>
        <button class="sidebar-toggle" data-action="toggle-sidebar">${sidebarVisible ? "Hide Panel" : "Show Panel"}</button>
    </div>
    </header>
    <div class="hud-content">
<section>
    <h2>Top Links</h2>
    <ul class="link-list">
        ${linkList}
    </ul>
</section>
<section class="routers">
    <h2>Routers</h2>
    <div class="router-grid">
        ${routerCards}
    </div>
</section>
${layoutMode ? `<section class="layout-panel">
    <h2>Layout Mode</h2>
    <p>Drag nodes directly on the canvas. Copy the generated coordinates back into <code>config.yaml</code>.</p>
    <textarea id="layout-snippet" readonly spellcheck="false"></textarea>
    <div class="layout-panel-actions">
        <button data-action="copy-layout">Copy JSON</button>
        <button data-action="exit-layout">Exit Layout Mode</button>
    </div>
</section>` : ""}</div>`;

    if (layoutMode) {
        const snippetEl = document.getElementById("layout-snippet") as HTMLTextAreaElement | null;
        if (snippetEl) {
            snippetEl.value = getLayoutSnippet();
        }
    }
    updateSidebarVisibility();
};

const getLayoutSnippet = () => {
    if (!topology) return "";
    const positions = topology.routers.reduce<Record<string, { position: Position }>>((acc, router) => {
        acc[router.id] = {
            position: {
                x: Math.round(router.position.x),
                y: Math.round(router.position.y)
            }
        };
        return acc;
    }, {});
    return JSON.stringify(positions, null, 2);
};

const flashButton = (button: HTMLButtonElement, message: string, duration = 1200) => {
    const previous = button.textContent ?? "";
    button.textContent = message;
    button.disabled = true;
    setTimeout(() => {
        button.textContent = previous;
        button.disabled = false;
    }, duration);
};

const copyLayoutSnippet = async (button?: HTMLButtonElement) => {
    const snippet = getLayoutSnippet();
    if (!snippet) return;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(snippet);
        } else {
            const textarea = document.createElement("textarea");
            textarea.value = snippet;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
        }
        if (button) {
            flashButton(button, "Copied!");
        }
    } catch (error) {
        console.error("Failed to copy layout snippet", error);
        if (button) {
            flashButton(button, "Copy failed");
        }
    }
};

const cancelDragging = () => {
    if (pointerState.pointerId !== null) {
        try {
            canvas.releasePointerCapture(pointerState.pointerId);
        } catch {
            // ignore
        }
    }
    pointerState.dragging = false;
    pointerState.routerId = null;
    pointerState.pointerId = null;
    pointerState.offset = null;
};

const setLayoutMode = (enabled: boolean) => {
    if (layoutMode === enabled) return;
    layoutMode = enabled;
    if (!enabled) {
        cancelDragging();
    }
    if (enabled) {
        rebuildLinkPaths();
    }
    renderHud();
    draw();
};

hud.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const hideButton = target.closest<HTMLButtonElement>("[data-action='toggle-sidebar']");
    if (hideButton) {
        event.preventDefault();
        sidebarVisible = !sidebarVisible;
        updateSidebarVisibility();
        hideButton.textContent = sidebarVisible ? "Hide Panel" : "Show Panel";
        return;
    }
    const toggleButton = target.closest<HTMLButtonElement>("[data-action='toggle-layout']");
    if (toggleButton) {
        event.preventDefault();
        setLayoutMode(!layoutMode);
        return;
    }
    const exitButton = target.closest<HTMLButtonElement>("[data-action='exit-layout']");
    if (exitButton) {
        event.preventDefault();
        setLayoutMode(false);
        return;
    }
    const copyButton = target.closest<HTMLButtonElement>("[data-action='copy-layout']");
    if (copyButton) {
        event.preventDefault();
        void copyLayoutSnippet(copyButton);
    }
});

sidebarPeekButton.addEventListener("click", () => {
    sidebarVisible = !sidebarVisible;
    updateSidebarVisibility();
    if (sidebarVisible) {
        renderHud();
    }
});

const ROUTER_HIT_RADIUS = 24;

const findRouterAtPoint = (point: Position): RouterDefinition | null => {
    if (!topology) return null;
    for (const router of topology.routers) {
        const dist = Math.hypot(router.position.x - point.x, router.position.y - point.y);
        if (dist <= ROUTER_HIT_RADIUS) {
            return router;
        }
    }
    return null;
};

const handlePointerDown = (event: PointerEvent) => {
    if (!layoutMode || !topology) return;
    const point = screenToMap(event.clientX, event.clientY);
    const router = findRouterAtPoint(point);
    if (!router) return;
    event.preventDefault();
    pointerState.dragging = true;
    pointerState.routerId = router.id;
    pointerState.pointerId = event.pointerId;
    pointerState.offset = {
        x: router.position.x - point.x,
        y: router.position.y - point.y
    };
    canvas.setPointerCapture(event.pointerId);
};

const handlePointerMove = (event: PointerEvent) => {
    if (!pointerState.dragging || pointerState.pointerId !== event.pointerId || !topology) return;
    const router = topology.routers.find(r => r.id === pointerState.routerId);
    if (!router) return;
    const point = screenToMap(event.clientX, event.clientY);
    const offset = pointerState.offset ?? { x: 0, y: 0 };
    router.position.x = Math.round(point.x + offset.x);
    router.position.y = Math.round(point.y + offset.y);
    rebuildLinkPaths();
    renderHud();
    draw();
};

const handlePointerUp = (event: PointerEvent) => {
    if (!pointerState.dragging) return;
    if (pointerState.pointerId === event.pointerId) {
        cancelDragging();
    }
};

canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointercancel", handlePointerUp);

window.addEventListener("keydown", event => {
    if (event.key === "Escape" && layoutMode) {
        setLayoutMode(false);
    }
});

const applyTopology = (next: TopologyDefinition) => {
    topology = next;
    rebuildLinkCapacities();
    rebuildLinkPaths();
    const url = new URL(next.backgroundImage, window.location.origin).toString();
    if (backgroundImage.src !== url) {
        backgroundLoaded = false;
        backgroundImage.src = url;
    }
    resizeCanvas();
    renderHud();
    draw();
};

const handleServerMessage = (message: ServerMessage) => {
    if (message.type === "topology") {
        applyTopology(message.topology);
        return;
    }

    metrics = message;
    renderHud();
    draw();
};

const fetchInitialTopology = async () => {
    const response = await fetch("/api/topology");
    if (!response.ok) {
        throw new Error("Failed to load topology");
    }
    const data = (await response.json()) as TopologyDefinition;
    applyTopology(data);
};

const fetchInitialMetrics = async () => {
    const response = await fetch("/api/metrics", { cache: "no-store" });
    if (response.status === 204) {
        return;
    }
    if (!response.ok) {
        throw new Error("Failed to load initial metrics");
    }
    const data = (await response.json()) as MetricsPayload;
    metrics = data;
    renderHud();
    draw();
};

const startWebSocket = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}`);

    socket.addEventListener("message", event => {
        const parsed = JSON.parse(event.data) as ServerMessage;
        handleServerMessage(parsed);
    });

    socket.addEventListener("close", () => {
        setTimeout(startWebSocket, 1000);
    });
};

window.addEventListener("resize", () => {
    if (!topology) return;
    resizeCanvas();
    draw();
});

void fetchInitialTopology()
    .then(() =>
        fetchInitialMetrics().catch(err => {
            console.warn("Failed to load initial metrics", err);
        })
    )
    .then(() => startWebSocket())
    .catch(err => {
        console.error("Failed to initialise application", err);
        hud.innerHTML = `<div class="hud-empty">Failed to load topology: ${err instanceof Error ? err.message : String(err)}</div>`;
    });
