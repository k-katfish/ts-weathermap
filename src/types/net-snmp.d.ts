declare module "net-snmp" {
    export interface Varbind {
        oid: string;
        type: number;
        value: unknown;
    }

    export type ResponseCallback = (error: Error | null, varbinds: Varbind[]) => void;

    export interface Session {
        get(oids: string[], callback: ResponseCallback): void;
        close(): void;
    }

    export function isVarbindError(varbind: Varbind): boolean;
    export function varbindError(varbind: Varbind): string;

    const netSnmp: {
        createSession(target: string, community: string, options?: Record<string, unknown>): Session;
        isVarbindError: typeof isVarbindError;
        varbindError: typeof varbindError;
    };

    export default netSnmp;
}
