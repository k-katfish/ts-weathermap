import express, { type Request, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";
import {
    LinkDefinition,
    LinkMetrics,
    MetricsPayload,
    RouterDefinition,
    RouterMetrics,
    ServerMessage,
    TopologyDefinition,
    TopologyPayload
} from "./shared/types.js";
import { pollRouters, PollSnapshot, RouterConfig } from "./snmp.js";
import { renderMapSnapshot } from "./map-renderer.js";

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve("/app/data");
const CONFIG_PATH = path.join(DATA_DIR, "config.yaml");
const IMAGE_DIR = path.join(DATA_DIR, "image_data");
const BACKGROUND_ROUTE = "/background.png";
const MAX_SAVED_MAP_IMAGES = 50;
let latestImagePath: string | null = null;

interface RawInterfaceConfig {
    name: string;
    oid_in: string;
    oid_out: string;
    max_bandwidth?: number;
    oid_speed?: string;
    oid_speed_scale?: number;
    display_name?: string;
}

interface RawRouterConfig {
    ip: string;
    community: string;
    label?: string;
    position?: {
        x: number;
        y: number;
    };
    interfaces: RawInterfaceConfig[];
}

interface RawLinkConfig {
    id?: string;
    from: string;
    to: string;
    iface_from: string;
    iface_to: string;
    label?: string;
    path?: Array<{
        x: number;
        y: number;
    }>;
}

interface RawConfig {
    meta?: {
        title?: string;
        poll_interval_ms?: number;
    };
    map?: {
        background?: string;
        size?: {
            width: number;
            height: number;
        };
    };
    routers: Record<string, RawRouterConfig>;
    links?: RawLinkConfig[];
}

interface RuntimeConfig {
    topology: TopologyDefinition;
    routerPollConfig: Record<string, RouterConfig>;
    pollIntervalMs: number;
    backgroundPath: string;
}

const ensureDirectory = (dir: string) => {
    if (!fs.existsSync(dir)) {
        throw new Error(`Expected directory to exist: ${dir}`);
    }
};

const ensureImageDirectory = () => {
    if (!fs.existsSync(IMAGE_DIR)) {
        fs.mkdirSync(IMAGE_DIR, { recursive: true });
    }
};

const collectSnapshotFiles = () => {
    if (!fs.existsSync(IMAGE_DIR)) {
        return [];
    }
    return fs
        .readdirSync(IMAGE_DIR)
        .filter(file => file.endsWith(".png"))
        .map(file => {
            const fullPath = path.join(IMAGE_DIR, file);
            try {
                const stats = fs.statSync(fullPath);
                return { fullPath, mtime: stats.mtimeMs };
            } catch {
                return null;
            }
        })
        .filter((entry): entry is { fullPath: string; mtime: number } => Boolean(entry))
        .sort((a, b) => b.mtime - a.mtime);
};

const pruneSnapshots = () => {
    const files = collectSnapshotFiles();
    if (files.length === 0) {
        latestImagePath = null;
        return;
    }
    latestImagePath = files[0].fullPath;
    files.slice(MAX_SAVED_MAP_IMAGES).forEach(file => {
        fs.unlink(file.fullPath, err => {
            if (err) {
                console.warn(`Failed to remove old snapshot ${file.fullPath}`, err);
            }
        });
    });
};

const readConfigFile = (filePath: string): RawConfig => {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Configuration file not found at ${filePath}`);
    }
    const contents = fs.readFileSync(filePath, "utf8");
    const parsed = yaml.load(contents) as RawConfig;
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid configuration file");
    }
    if (!parsed.routers || Object.keys(parsed.routers).length === 0) {
        throw new Error("Configuration must define at least one router");
    }
    return parsed;
};

const resolveDataPath = (maybeRelative: string | undefined): string => {
    const fallback = "background.png";
    const trimmed = maybeRelative?.trim();
    const filename = trimmed ? path.basename(trimmed) : fallback;
    return path.join(DATA_DIR, filename);
};

const normaliseRouters = (routers: Record<string, RawRouterConfig>) => {
    const routerPollConfig: Record<string, RouterConfig> = {};
    const routerDefinitions: RouterDefinition[] = [];

    for (const [routerId, router] of Object.entries(routers)) {
        if (!router.ip || !router.community) {
            throw new Error(`Router "${routerId}" must define both ip and community`);
        }
        if (!router.interfaces || router.interfaces.length === 0) {
            throw new Error(`Router "${routerId}" must define at least one interface`);
        }

        const normalizedInterfaces = router.interfaces.map(iface => {
            if (!iface.name) {
                throw new Error(`Router "${routerId}" has an interface without a name`);
            }
            if (!iface.oid_in || !iface.oid_out) {
                throw new Error(`Interface "${iface.name}" on router "${routerId}" must define both oid_in and oid_out`);
            }
            const trimmedSpeedOid = iface.oid_speed?.trim() || undefined;
            const hasSpeedScale = typeof iface.oid_speed_scale === "number" && Number.isFinite(iface.oid_speed_scale);
            const speedScale =
                trimmedSpeedOid && hasSpeedScale && iface.oid_speed_scale! > 0 ? iface.oid_speed_scale! : 1;
            const hasStaticBandwidth = typeof iface.max_bandwidth === "number" && iface.max_bandwidth > 0;
            if (!hasStaticBandwidth && !trimmedSpeedOid) {
                throw new Error(
                    `Interface "${iface.name}" on router "${routerId}" must define either max_bandwidth (> 0) or oid_speed`
                );
            }
            return {
                poll: {
                    name: iface.name,
                    oid_in: iface.oid_in,
                    oid_out: iface.oid_out,
                    max_bandwidth: hasStaticBandwidth ? iface.max_bandwidth : 0,
                    oid_speed: trimmedSpeedOid,
                    oid_speed_scale: trimmedSpeedOid ? speedScale : undefined,
                    display_name: iface.display_name ?? iface.name
                },
                definition: {
                    name: iface.name,
                    displayName: iface.display_name ?? iface.name,
                    maxBandwidth: hasStaticBandwidth ? iface.max_bandwidth : null,
                    speedOid: trimmedSpeedOid,
                    speedScale: trimmedSpeedOid ? speedScale : undefined
                }
            };
        });

        routerPollConfig[routerId] = {
            ip: router.ip,
            community: router.community,
            label: router.label ?? routerId,
            interfaces: normalizedInterfaces.map(entry => entry.poll)
        };

        routerDefinitions.push({
            id: routerId,
            label: router.label ?? routerId,
            position: {
                x: router.position?.x ?? 0,
                y: router.position?.y ?? 0
            },
            interfaces: normalizedInterfaces.map(entry => entry.definition)
        });
    }

    return { routerPollConfig, routerDefinitions };
};

const normalizePath = (path: RawLinkConfig["path"]) => {
    if (!path) return undefined;
    if (!Array.isArray(path) || path.length === 0) return undefined;
    return path.map((point, index) => {
        if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
            throw new Error(`Link path point #${index} must declare numeric x/y coordinates`);
        }
        return { x: point.x, y: point.y };
    });
};

const normaliseLinks = (links: RawLinkConfig[] | undefined, routers: Record<string, RawRouterConfig>): LinkDefinition[] => {
    if (!links) return [];
    return links.map((link, index) => ({
        id: link.id ?? `${link.from}-${link.to}-${index}`,
        from: link.from,
        to: link.to,
        ifaceFrom: link.iface_from,
        ifaceTo: link.iface_to,
        label: link.label,
        path: normalizePath(link.path)
    })).map(link => {
        const fromRouter = routers[link.from];
        const toRouter = routers[link.to];
        if (!fromRouter) {
            throw new Error(`Link "${link.id}" references unknown router "${link.from}"`);
        }
        if (!toRouter) {
            throw new Error(`Link "${link.id}" references unknown router "${link.to}"`);
        }
        const fromIface = fromRouter.interfaces.find(iface => iface.name === link.ifaceFrom);
        const toIface = toRouter.interfaces.find(iface => iface.name === link.ifaceTo);
        if (!fromIface) {
            throw new Error(`Link "${link.id}" references unknown interface "${link.ifaceFrom}" on router "${link.from}"`);
        }
        if (!toIface) {
            throw new Error(`Link "${link.id}" references unknown interface "${link.ifaceTo}" on router "${link.to}"`);
        }
        return link;
    });
};

const loadRuntimeConfig = (): RuntimeConfig => {
    ensureDirectory(DATA_DIR);
    ensureImageDirectory();
    const raw = readConfigFile(CONFIG_PATH);
    const { routerPollConfig, routerDefinitions } = normaliseRouters(raw.routers);
    const links = normaliseLinks(raw.links, raw.routers);

    const pollIntervalMs = raw.meta?.poll_interval_ms ?? 5000;
    const backgroundPath = resolveDataPath(raw.map?.background);
    if (!fs.existsSync(backgroundPath)) {
        console.warn(`Background image not found at ${backgroundPath}. The frontend will show an empty canvas.`);
    }

    const mapSizeRaw = raw.map?.size;
    const mapSize = mapSizeRaw && typeof mapSizeRaw.width === "number" && typeof mapSizeRaw.height === "number"
        ? mapSizeRaw
        : undefined;

    const topology: TopologyDefinition = {
        title: raw.meta?.title ?? "TS Weathermap",
        backgroundImage: BACKGROUND_ROUTE,
        mapSize,
        pollIntervalMs,
        routers: routerDefinitions,
        links
    };

    return {
        topology,
        routerPollConfig,
        pollIntervalMs,
        backgroundPath
    };
};

const toRouterMetrics = (snapshot: PollSnapshot, topology: TopologyDefinition): Record<string, RouterMetrics> => {
    const metrics: Record<string, RouterMetrics> = {};

    for (const router of topology.routers) {
        const sample = snapshot[router.id];
        if (!sample) {
            metrics[router.id] = {
                id: router.id,
                label: router.label,
                status: "error",
                error: "No SNMP data",
                interfaces: router.interfaces.reduce<Record<string, RouterMetrics["interfaces"][string]>>((acc, iface) => {
                    acc[iface.name] = {
                        name: iface.name,
                        inBps: 0,
                        outBps: 0,
                        inUtilization: 0,
                        outUtilization: 0,
                        status: "error",
                        maxBandwidth: iface.maxBandwidth ?? 0,
                        fresh: false,
                        error: "No SNMP data"
                    };
                    return acc;
                }, {})
            };
            continue;
        }

        const ifaceMetrics = router.interfaces.reduce<Record<string, RouterMetrics["interfaces"][string]>>((acc, iface) => {
            const ifaceSample = sample.interfaces[iface.name];
            if (!ifaceSample) {
                acc[iface.name] = {
                    name: iface.name,
                    inBps: 0,
                    outBps: 0,
                    inUtilization: 0,
                    outUtilization: 0,
                    status: "error",
                    maxBandwidth: iface.maxBandwidth ?? 0,
                    fresh: false,
                    error: "Interface missing from SNMP poll"
                };
                return acc;
            }

            acc[iface.name] = {
                name: ifaceSample.name,
                inBps: ifaceSample.inBps,
                outBps: ifaceSample.outBps,
                inUtilization: ifaceSample.inUtilization,
                outUtilization: ifaceSample.outUtilization,
                status: ifaceSample.status,
                maxBandwidth: ifaceSample.maxBandwidth,
                fresh: ifaceSample.fresh,
                error: ifaceSample.error
            };
            return acc;
        }, {});

        metrics[router.id] = {
            id: router.id,
            label: router.label,
            status: sample.status,
            interfaces: ifaceMetrics,
            ...(sample.error ? { error: sample.error } : {})
        };
    }

    return metrics;
};

const utilisationForInterface = (iface: RouterMetrics["interfaces"][string] | null | undefined): number | null => {
    if (!iface) return null;
    return Math.max(iface.inUtilization, iface.outUtilization);
};

const toLinkMetrics = (routers: Record<string, RouterMetrics>, links: LinkDefinition[]): LinkMetrics[] => {
    return links.map(link => {
        const forward = routers[link.from]?.interfaces[link.ifaceFrom] ?? null;
        const reverse = routers[link.to]?.interfaces[link.ifaceTo] ?? null;
        const forwardUtil = utilisationForInterface(forward);
        const reverseUtil = utilisationForInterface(reverse);

        let aggregateUtilization: number | null = null;
        if (forwardUtil !== null || reverseUtil !== null) {
            aggregateUtilization = Math.max(forwardUtil ?? 0, reverseUtil ?? 0);
        }

        return {
            id: link.id,
            label: link.label,
            from: link.from,
            to: link.to,
            forward,
            reverse,
            aggregateUtilization
        };
    });
};

const runtime: { config: RuntimeConfig } = {
    config: loadRuntimeConfig()
};
pruneSnapshots();
let latestMetrics: MetricsPayload | null = null;

const saveSnapshotImage = async (payload: MetricsPayload) => {
    try {
        const imagePath = await renderMapSnapshot({
            topology: runtime.config.topology,
            metrics: payload,
            backgroundPath: runtime.config.backgroundPath,
            outputDir: IMAGE_DIR
        });
        if (imagePath) {
            latestImagePath = imagePath;
            pruneSnapshots();
        }
    } catch (error) {
        console.error("Failed to render map snapshot", error);
    }
};

const app = express();

app.get(BACKGROUND_ROUTE, (_, res) => {
    res.sendFile(runtime.config.backgroundPath, err => {
        if (err) {
            res.status(404).send("Background not found");
        }
    });
});

const sendLatestSnapshot = (res: Response) => {
    if (!latestImagePath) {
        res.status(404).send("Map image not available");
        return;
    }
    res.sendFile(latestImagePath, err => {
        if (err) {
            res.status(404).send("Map image not available");
        }
    });
};

app.get("/", (_req, res) => {
    sendLatestSnapshot(res);
});

app.use("/manage", express.static("src/frontend"));

app.get("/api/topology", (_req, res) => {
    res.json(runtime.config.topology);
});

app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
});

app.get("/api/metrics", (_req, res) => {
    if (!latestMetrics) {
        res.status(204).end();
        return;
    }
    res.json(latestMetrics);
});

app.get("/map.png", (_req, res) => {
    sendLatestSnapshot(res);
});

const server = app.listen(PORT, () => {
    console.log(`Weathermap 🌤️ running on :${PORT}`);
});

const wss = new WebSocketServer({ server });

const broadcast = (message: ServerMessage) => {
    const payload = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
};

const broadcastTopology = () => {
    const message: TopologyPayload = { type: "topology", topology: runtime.config.topology };
    broadcast(message);
};

wss.on("connection", socket => {
    const message: TopologyPayload = { type: "topology", topology: runtime.config.topology };
    socket.send(JSON.stringify(message));
    if (latestMetrics) {
        socket.send(JSON.stringify(latestMetrics));
    }
});

const pollLoop = async (): Promise<void> => {
    try {
        const snapshot = await pollRouters(runtime.config.routerPollConfig);
        const routers = toRouterMetrics(snapshot, runtime.config.topology);
        const links = toLinkMetrics(routers, runtime.config.topology.links);
        const payload: MetricsPayload = {
            type: "metrics",
            timestamp: new Date().toISOString(),
            routers,
            links
        };
        latestMetrics = payload;
        broadcast(payload);
        await saveSnapshotImage(payload);
    } catch (error) {
        console.error("Failed to poll routers", error);
    } finally {
        setTimeout(pollLoop, runtime.config.pollIntervalMs);
    }
};

pollLoop().catch(err => console.error("Initial poll loop failed", err));

fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
    try {
        runtime.config = loadRuntimeConfig();
        pruneSnapshots();
        console.log("Configuration reloaded");
        broadcastTopology();
    } catch (error) {
        console.error("Failed to reload configuration", error);
    }
});
