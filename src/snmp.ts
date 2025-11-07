import snmp, { Varbind } from "net-snmp";
import { MetricStatus } from "./shared/types.js";

export interface InterfaceConfig {
    name: string;
    oid_in: string;
    oid_out: string;
    max_bandwidth?: number;
    oid_speed?: string;
    oid_speed_scale?: number;
    display_name?: string;
}

export interface RouterConfig {
    ip: string;
    community: string;
    label?: string;
    interfaces: InterfaceConfig[];
}

export interface InterfaceSample {
    name: string;
    inOctets: number | null;
    outOctets: number | null;
    inBps: number;
    outBps: number;
    inUtilization: number;
    outUtilization: number;
    status: MetricStatus;
    maxBandwidth: number;
    fresh: boolean;
    error?: string;
}

export interface RouterSample {
    status: MetricStatus;
    interfaces: Record<string, InterfaceSample>;
    error?: string;
}

export type PollSnapshot = Record<string, RouterSample>;

type OidKind = "in" | "out" | "speed";

interface SampleCacheEntry {
    inOctets: number;
    outOctets: number;
    timestamp: number;
}

const sampleCache = new Map<string, SampleCacheEntry>();

const STATUS_ORDER: MetricStatus[] = ["ok", "warning", "critical", "error"];

const sanitizeOid = (raw: string): { oid: string | null; error?: string } => {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { oid: null, error: "OID is required" };
    }

    const segments = trimmed.split(".").filter(Boolean);
    if (segments.length === 0) {
        return { oid: null, error: `OID "${raw}" is not a dotted numeric string` };
    }

    for (const segment of segments) {
        if (!/^\d+$/.test(segment)) {
            return { oid: null, error: `OID "${raw}" contains invalid segment "${segment}"` };
        }
    }

    return { oid: segments.join("."), error: undefined };
};

const metricStatus = (utilization: number, hasError: boolean): MetricStatus => {
    if (hasError) return "error";
    if (utilization >= 0.9) return "critical";
    if (utilization >= 0.75) return "warning";
    return "ok";
};

const combineStatuses = (statuses: MetricStatus[]): MetricStatus => {
    return statuses.reduce((highest, current) => {
        return STATUS_ORDER.indexOf(current) > STATUS_ORDER.indexOf(highest) ? current : highest;
    }, "ok" as MetricStatus);
};

const getVarbinds = (session: snmp.Session, oids: string[]): Promise<Varbind[]> => {
    return new Promise((resolve, reject) => {
        session.get(oids, (err: Error | null, varbinds: Varbind[]) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(varbinds);
        });
    });
};

const parseNumericValue = (varbind: Varbind | undefined): number | null => {
    if (!varbind) return null;
    if (typeof varbind.value === "number") {
        return varbind.value;
    }
    return null;
};

const computeThroughput = (current: number | null, previous: SampleCacheEntry | undefined, deltaMs: number, direction: "in" | "out"): { bps: number; fresh: boolean } => {
    if (current === null || !previous || deltaMs <= 0) {
        return { bps: 0, fresh: false };
    }

    const previousValue = direction === "in" ? previous.inOctets : previous.outOctets;
    if (current < previousValue) {
        // Counter wrapped or reset; wait for next sample.
        return { bps: 0, fresh: false };
    }

    const octetDelta = current - previousValue;
    const bits = octetDelta * 8;
    const seconds = deltaMs / 1000;
    if (seconds === 0) {
        return { bps: 0, fresh: false };
    }

    return { bps: bits / seconds, fresh: true };
};

const makeInterfaceSample = (iface: InterfaceConfig): InterfaceSample => ({
    name: iface.name,
    inOctets: null,
    outOctets: null,
    inBps: 0,
    outBps: 0,
    inUtilization: 0,
    outUtilization: 0,
    status: "ok",
    maxBandwidth: typeof iface.max_bandwidth === "number" && iface.max_bandwidth > 0 ? iface.max_bandwidth : 0,
    fresh: false
});

const cacheKey = (routerId: string, ifaceName: string): string => `${routerId}:${ifaceName}`;

async function pollRouter(routerId: string, router: RouterConfig): Promise<RouterSample> {
    if (!router.interfaces || router.interfaces.length === 0) {
        return {
            status: "error",
            interfaces: {},
            error: "No interfaces configured"
        };
    }

    const interfaceTargets: {
        iface: InterfaceConfig;
        entries: Array<{ oid: string; kind: OidKind }>;
        hasCounters: boolean;
    }[] = [];
    const sample: RouterSample = {
        status: "ok",
        interfaces: {}
    };

    let hasValidCounterOid = false;

    for (const iface of router.interfaces) {
        const ifaceSample = makeInterfaceSample(iface);
        sample.interfaces[iface.name] = ifaceSample;
        const target = { iface, entries: [] as Array<{ oid: string; kind: OidKind }>, hasCounters: false };
        const sanitizedIn = sanitizeOid(iface.oid_in);
        const sanitizedOut = sanitizeOid(iface.oid_out);

        if (sanitizedIn.oid) {
            target.entries.push({ oid: sanitizedIn.oid, kind: "in" });
            target.hasCounters = true;
            hasValidCounterOid = true;
        } else if (sanitizedIn.error) {
            ifaceSample.error = sanitizedIn.error;
            ifaceSample.status = "error";
        }

        if (sanitizedOut.oid) {
            target.entries.push({ oid: sanitizedOut.oid, kind: "out" });
            target.hasCounters = true;
            hasValidCounterOid = true;
        } else if (sanitizedOut.error) {
            ifaceSample.error = sanitizedOut.error;
            ifaceSample.status = "error";
        }

        if (iface.oid_speed) {
            const sanitizedSpeed = sanitizeOid(iface.oid_speed);
            if (sanitizedSpeed.oid) {
                target.entries.push({ oid: sanitizedSpeed.oid, kind: "speed" });
            } else if (sanitizedSpeed.error) {
                ifaceSample.error = sanitizedSpeed.error;
                ifaceSample.status = "error";
            }
        }

        interfaceTargets.push(target);
    }

    if (!hasValidCounterOid) {
        sample.status = combineStatuses(Object.values(sample.interfaces).map(i => i.status));
        return sample;
    }

    const session = snmp.createSession(router.ip, router.community);

    const now = Date.now();

    try {
        for (const target of interfaceTargets) {
            if (!target.hasCounters) continue;
            const ifaceSample = sample.interfaces[target.iface.name];
            if (!ifaceSample) continue;
            const oidList = target.entries.map(entry => entry.oid);
            if (oidList.length === 0) continue;

            let varbinds: Varbind[];
            try {
                varbinds = await getVarbinds(session, oidList);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ifaceSample.error = message;
                ifaceSample.status = "error";
                continue;
            }

            const scale = target.iface.oid_speed_scale && target.iface.oid_speed_scale > 0 ? target.iface.oid_speed_scale : 1;

            varbinds.forEach((varbind, index) => {
                const meta = target.entries[index];
                if (!meta) return;

                if (snmp.isVarbindError(varbind)) {
                    ifaceSample.error = snmp.varbindError(varbind);
                    ifaceSample.status = "error";
                    return;
                }

                const numericValue = parseNumericValue(varbind);
                if (numericValue === null) {
                    const targetLabel = meta.kind === "speed" ? "speed" : `${meta.kind}put`;
                    ifaceSample.error = `Unexpected value type for ${targetLabel} OID`;
                    ifaceSample.status = "error";
                    return;
                }

                if (meta.kind === "speed") {
                    if (numericValue > 0) {
                        ifaceSample.maxBandwidth = numericValue * scale;
                    }
                } else if (meta.kind === "in") {
                    ifaceSample.inOctets = numericValue;
                } else {
                    ifaceSample.outOctets = numericValue;
                }
            });
        }
    } finally {
        session.close();
    }

    for (const iface of router.interfaces) {
        const ifaceSample = sample.interfaces[iface.name];
        const key = cacheKey(routerId, iface.name);
        const previous = sampleCache.get(key);
        const deltaMs = previous ? now - previous.timestamp : 0;

        const inResult = computeThroughput(ifaceSample.inOctets, previous, deltaMs, "in");
        const outResult = computeThroughput(ifaceSample.outOctets, previous, deltaMs, "out");

        ifaceSample.inBps = inResult.bps;
        ifaceSample.outBps = outResult.bps;

        const maxBandwidth = ifaceSample.maxBandwidth > 0 ? ifaceSample.maxBandwidth : 1;
        ifaceSample.inUtilization = ifaceSample.inBps / maxBandwidth;
        ifaceSample.outUtilization = ifaceSample.outBps / maxBandwidth;

        const util = Math.max(ifaceSample.inUtilization, ifaceSample.outUtilization);
        const hasError = Boolean(ifaceSample.error);
        ifaceSample.status = metricStatus(util, hasError);
        ifaceSample.fresh = inResult.fresh && outResult.fresh;

        if (typeof ifaceSample.inOctets === "number" && typeof ifaceSample.outOctets === "number") {
            sampleCache.set(key, {
                inOctets: ifaceSample.inOctets,
                outOctets: ifaceSample.outOctets,
                timestamp: now
            });
        }
    }

    const ifaceStatuses = Object.values(sample.interfaces).map(i => i.status);
    sample.status = combineStatuses(ifaceStatuses);
    return sample;
}

export async function pollRouters(routers: Record<string, RouterConfig>): Promise<PollSnapshot> {
    const entries = Object.entries(routers);
    const samples = await Promise.all(entries.map(async ([routerId, router]) => {
        const result = await pollRouter(routerId, router);
        return [routerId, result] as const;
    }));
    return Object.fromEntries(samples);
}
