export interface Position {
    x: number;
    y: number;
}

export interface InterfaceDefinition {
    name: string;
    displayName?: string;
    maxBandwidth?: number | null;
    speedOid?: string;
}

export interface RouterDefinition {
    id: string;
    label: string;
    position: Position;
    interfaces: InterfaceDefinition[];
}

export interface LinkDefinition {
    id: string;
    from: string;
    to: string;
    ifaceFrom: string;
    ifaceTo: string;
    label?: string;
    path?: Position[];
}

export interface TopologyDefinition {
    title?: string;
    backgroundImage: string;
    mapSize?: {
        width: number;
        height: number;
    };
    pollIntervalMs: number;
    routers: RouterDefinition[];
    links: LinkDefinition[];
}

export type MetricStatus = "ok" | "warning" | "critical" | "error";

export interface InterfaceMetrics {
    name: string;
    inBps: number;
    outBps: number;
    inUtilization: number;
    outUtilization: number;
    status: MetricStatus;
    maxBandwidth: number;
    fresh: boolean;
    error?: string;
}

export interface RouterMetrics {
    id: string;
    label: string;
    status: MetricStatus;
    interfaces: Record<string, InterfaceMetrics>;
    error?: string;
}

export interface LinkMetrics {
    id: string;
    label?: string;
    from: string;
    to: string;
    forward: InterfaceMetrics | null;
    reverse: InterfaceMetrics | null;
    aggregateUtilization: number | null;
}

export interface MetricsPayload {
    type: "metrics";
    timestamp: string;
    routers: Record<string, RouterMetrics>;
    links: LinkMetrics[];
}

export interface TopologyPayload {
    type: "topology";
    topology: TopologyDefinition;
}

export type ServerMessage = MetricsPayload | TopologyPayload;
