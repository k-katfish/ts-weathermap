import fs from "fs";
import path from "path";
import { CanvasRenderingContext2D, createCanvas, loadImage } from "canvas";
import {
    InterfaceDefinition,
    InterfaceMetrics,
    LinkDefinition,
    LinkMetrics,
    MetricsPayload,
    Position,
    RouterDefinition,
    TopologyDefinition
} from "./shared/types.js";
import { splitPathAtHalf } from "./shared/path-utils.js";

const DEFAULT_SIZE = { width: 1600, height: 900 };
const MIN_LINK_WIDTH = 2;
const MAX_LINK_WIDTH = 14;

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

export interface MapRenderOptions {
    topology: TopologyDefinition;
    metrics: MetricsPayload;
    backgroundPath: string;
    outputDir: string;
}

const formatFileTimestamp = (date: Date): string => {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const formatLabelTimestamp = (date: Date): string => {
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const buildRouterMap = (routers: RouterDefinition[]) => {
    const map = new Map<string, RouterDefinition>();
    routers.forEach(router => map.set(router.id, router));
    return map;
};

const computeLinkCapacities = (routers: RouterDefinition[], links: LinkDefinition[]) => {
    const routerMap = buildRouterMap(routers);
    const map = new Map<string, number | null>();
    const capacities: number[] = [];

    links.forEach(link => {
        const forwardRouter = routerMap.get(link.from);
        const reverseRouter = routerMap.get(link.to);
        const forwardCapacity = getInterfaceCapacity(forwardRouter, link.ifaceFrom);
        const reverseCapacity = getInterfaceCapacity(reverseRouter, link.ifaceTo);
        const candidates = [forwardCapacity, reverseCapacity].filter(
            (value): value is number => typeof value === "number" && value > 0
        );
        const capacity = candidates.length ? Math.min(...candidates) : null;
        if (capacity !== null) {
            capacities.push(capacity);
        }
        map.set(link.id, capacity);
    });

    return { capacities, map };
};

const getInterfaceCapacity = (router: RouterDefinition | undefined, ifaceName: string): number | null => {
    if (!router) return null;
    const iface = router.interfaces.find(candidate => candidate.name === ifaceName);
    return iface ? iface.maxBandwidth : null;
};

const computeAutoPath = (from: Position, to: Position, groupSize: number, index: number): Position[] => {
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

const computeLinkPaths = (topology: TopologyDefinition): Map<string, Position[]> => {
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

    manualPaths.forEach((pathPoints, id) => {
        if (!paths.has(id)) {
            paths.set(id, pathPoints);
        }
    });

    return paths;
};

const interfaceUtilization = (iface: InterfaceMetrics | null | undefined): number | null => {
    if (!iface) return null;
    return Math.max(iface.inUtilization, iface.outUtilization);
};

const utilToColor = (utilization: number | null): string => {
    if (utilization === null || Number.isNaN(utilization)) {
        return "#5a646d";
    }
    const bucket =
        UTILIZATION_BUCKETS.find(range => utilization >= range.min && utilization < range.max) ??
        UTILIZATION_BUCKETS[UTILIZATION_BUCKETS.length - 1];
    return bucket.color;
};

const drawHalfStroke = (ctx: CanvasRenderingContext2D, pathPoints: Position[], color: string, width: number) => {
    if (pathPoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawPathStroke(ctx, pathPoints);
    ctx.restore();
};

const capacityToWidth = (capacity: number | null, range: { min: number; max: number } | null): number => {
    if (!capacity || !range) {
        return MIN_LINK_WIDTH;
    }
    const { min, max } = range;
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

const drawBackground = async (ctx: CanvasRenderingContext2D, width: number, height: number, backgroundPath: string) => {
    try {
        if (backgroundPath && fs.existsSync(backgroundPath)) {
            const image = await loadImage(backgroundPath);
            ctx.drawImage(image, 0, 0, width, height);
            return;
        }
    } catch {
        // fall back to gradient if image loading fails
    }
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#0b1120");
    gradient.addColorStop(1, "#111827");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
};

const drawPathStroke = (ctx: CanvasRenderingContext2D, pathPoints: Position[]) => {
    if (pathPoints.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
    if (pathPoints.length === 2) {
        ctx.lineTo(pathPoints[1].x, pathPoints[1].y);
    } else {
        for (let i = 1; i < pathPoints.length - 1; i++) {
            const current = pathPoints[i];
            const next = pathPoints[i + 1];
            const midX = (current.x + next.x) / 2;
            const midY = (current.y + next.y) / 2;
            ctx.quadraticCurveTo(current.x, current.y, midX, midY);
        }
        ctx.lineTo(pathPoints[pathPoints.length - 1].x, pathPoints[pathPoints.length - 1].y);
    }
    ctx.stroke();
};

const drawLink = (
    ctx: CanvasRenderingContext2D,
    pathPoints: Position[],
    forwardUtilization: number | null,
    reverseUtilization: number | null,
    capacity: number | null,
    label: string | undefined,
    capacityRange: { min: number; max: number } | null
) => {
    if (pathPoints.length < 2) return;
    const width = capacityToWidth(capacity, capacityRange);
    const { midpoint, firstHalf, secondHalf } = splitPathAtHalf(pathPoints);
    const forwardPath = firstHalf;
    const reversePath = secondHalf;

    if (forwardPath.length >= 2) {
        drawHalfStroke(ctx, forwardPath, utilToColor(forwardUtilization), width);
    }

    if (reversePath.length >= 2) {
        drawHalfStroke(ctx, reversePath, utilToColor(reverseUtilization), width);
    }

    if (label) {
        ctx.save();
        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = 1;
        ctx.font = "12px 'Inter', 'Segoe UI', sans-serif";
        const padding = 6;
        const textMetrics = ctx.measureText(label);
        const boxWidth = textMetrics.width + padding * 2;
        const boxHeight = 18;
        const x = midpoint.x - boxWidth / 2;
        const y = midpoint.y - boxHeight / 2;
        ctx.beginPath();
        ctx.moveTo(x + 4, y);
        ctx.lineTo(x + boxWidth - 4, y);
        ctx.quadraticCurveTo(x + boxWidth, y, x + boxWidth, y + 4);
        ctx.lineTo(x + boxWidth, y + boxHeight - 4);
        ctx.quadraticCurveTo(x + boxWidth, y + boxHeight, x + boxWidth - 4, y + boxHeight);
        ctx.lineTo(x + 4, y + boxHeight);
        ctx.quadraticCurveTo(x, y + boxHeight, x, y + boxHeight - 4);
        ctx.lineTo(x, y + 4);
        ctx.quadraticCurveTo(x, y, x + 4, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(label, midpoint.x - textMetrics.width / 2, midpoint.y + 4);
        ctx.restore();
    }
};

const drawRouter = (ctx: CanvasRenderingContext2D, router: RouterDefinition, status: string) => {
    const colorMap: Record<string, string> = {
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
    ctx.beginPath();
    ctx.moveTo(x + 4, y);
    ctx.lineTo(x + boxWidth - 4, y);
    ctx.quadraticCurveTo(x + boxWidth, y, x + boxWidth, y + 4);
    ctx.lineTo(x + boxWidth, y + boxHeight - 4);
    ctx.quadraticCurveTo(x + boxWidth, y + boxHeight, x + boxWidth - 4, y + boxHeight);
    ctx.lineTo(x + 4, y + boxHeight);
    ctx.quadraticCurveTo(x, y + boxHeight, x, y + boxHeight - 4);
    ctx.lineTo(x, y + 4);
    ctx.quadraticCurveTo(x, y, x + 4, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(label, router.position.x - metrics.width / 2, y + 14);
    ctx.restore();
};

const drawLegendOverlay = (ctx: CanvasRenderingContext2D, title: string, timestampLabel: string, width: number) => {
    const panelWidth = 280;
    const panelHeight = 250;
    const padding = 16;
    const x = width - panelWidth - padding;
    const y = padding;
    ctx.save();
    ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
    ctx.strokeStyle = "rgba(59, 130, 246, 0.35)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + 18, y);
    ctx.lineTo(x + panelWidth - 18, y);
    ctx.quadraticCurveTo(x + panelWidth, y, x + panelWidth, y + 18);
    ctx.lineTo(x + panelWidth, y + panelHeight - 18);
    ctx.quadraticCurveTo(x + panelWidth, y + panelHeight, x + panelWidth - 18, y + panelHeight);
    ctx.lineTo(x + 18, y + panelHeight);
    ctx.quadraticCurveTo(x, y + panelHeight, x, y + panelHeight - 18);
    ctx.lineTo(x, y + 18);
    ctx.quadraticCurveTo(x, y, x + 18, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "16px 'Inter', 'Segoe UI', sans-serif";
    ctx.fillText(title, x + 20, y + 32);
    ctx.font = "12px 'Inter', 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(226, 232, 240, 0.8)";
    ctx.fillText(`Last updated ${timestampLabel}`, x + 20, y + 52);

    const legendStartY = y + 72;
    UTILIZATION_BUCKETS.forEach((bucket, index) => {
        const itemY = legendStartY + index * 18;
        ctx.fillStyle = bucket.color;
        ctx.fillRect(x + 20, itemY, 18, 18);
        ctx.strokeStyle = "rgba(15, 23, 42, 0.4)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 20, itemY, 18, 18);
        ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
        ctx.fillText(bucket.label, x + 48, itemY + 14);
    });
    ctx.restore();
};

export const renderMapSnapshot = async (options: MapRenderOptions): Promise<string | null> => {
    const { topology, metrics, backgroundPath, outputDir } = options;
    const width = topology.mapSize?.width ?? DEFAULT_SIZE.width;
    const height = topology.mapSize?.height ?? DEFAULT_SIZE.height;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    await drawBackground(ctx, width, height, backgroundPath);

    const routerMap = buildRouterMap(topology.routers);
    const linkMetricsMap = new Map<string, LinkMetrics>();
    metrics.links.forEach(link => linkMetricsMap.set(link.id, link));

    const { capacities, map: capacityMap } = computeLinkCapacities(topology.routers, topology.links);
    const capacityRange = capacities.length ? { min: Math.min(...capacities), max: Math.max(...capacities) } : null;
    const linkPaths = computeLinkPaths(topology);

    topology.links.forEach(link => {
        const fromRouter = routerMap.get(link.from);
        const toRouter = routerMap.get(link.to);
        if (!fromRouter || !toRouter) return;
        const linkMetrics = linkMetricsMap.get(link.id);
        const forwardUtil = interfaceUtilization(linkMetrics?.forward);
        const reverseUtil = interfaceUtilization(linkMetrics?.reverse);
        const pathPoints = linkPaths.get(link.id) ?? [fromRouter.position, toRouter.position];
        drawLink(
            ctx,
            pathPoints,
            forwardUtil,
            reverseUtil,
            capacityMap.get(link.id) ?? null,
            linkMetrics?.label ?? link.label,
            capacityRange
        );
    });

    topology.routers.forEach(router => {
        const routerMetrics = metrics.routers[router.id];
        drawRouter(ctx, router, routerMetrics?.status ?? "error");
    });

    const timestamp = metrics.timestamp ? new Date(metrics.timestamp) : new Date();
    const timestampLabel = formatLabelTimestamp(timestamp);
    drawLegendOverlay(ctx, topology.title ?? "TS Weathermap", timestampLabel, width);

    await fs.promises.mkdir(outputDir, { recursive: true });
    const fileName = `${formatFileTimestamp(new Date())}.png`;
    const outputPath = path.join(outputDir, fileName);
    await fs.promises.writeFile(outputPath, canvas.toBuffer("image/png"));
    return outputPath;
};
