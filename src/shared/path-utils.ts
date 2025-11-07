import { Position } from "./types.js";

export interface SplitPathResult {
    midpoint: Position;
    firstHalf: Position[];
    secondHalf: Position[];
}

const clonePosition = (point: Position): Position => ({ x: point.x, y: point.y });

export const splitPathAtHalf = (path: Position[]): SplitPathResult => {
    if (path.length === 0) {
        const origin = { x: 0, y: 0 };
        return { midpoint: origin, firstHalf: [origin], secondHalf: [origin] };
    }

    if (path.length === 1) {
        const point = clonePosition(path[0]);
        return { midpoint: point, firstHalf: [point], secondHalf: [point] };
    }

    let totalLength = 0;
    const segmentLengths: number[] = [];

    for (let i = 0; i < path.length - 1; i++) {
        const start = path[i];
        const end = path[i + 1];
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        segmentLengths.push(length);
        totalLength += length;
    }

    if (totalLength === 0) {
        const midpoint = clonePosition(path[Math.floor(path.length / 2)]);
        return {
            midpoint,
            firstHalf: [clonePosition(path[0]), midpoint],
            secondHalf: [midpoint, clonePosition(path[path.length - 1])]
        };
    }

    const halfway = totalLength / 2;
    let accumulated = 0;

    for (let i = 0; i < segmentLengths.length; i++) {
        const length = segmentLengths[i];
        const start = path[i];
        const end = path[i + 1];

        if (accumulated + length >= halfway) {
            const remaining = halfway - accumulated;
            const ratio = length === 0 ? 0 : remaining / length;
            const midpoint = {
                x: start.x + (end.x - start.x) * ratio,
                y: start.y + (end.y - start.y) * ratio
            };

            const firstHalf = path.slice(0, i + 1).map(clonePosition);
            firstHalf.push(midpoint);

            const secondHalf = [midpoint, ...path.slice(i + 1).map(clonePosition)];

            return { midpoint, firstHalf, secondHalf };
        }

        accumulated += length;
    }

    const fallbackMidpoint = clonePosition(path[path.length - 1]);
    return {
        midpoint: fallbackMidpoint,
        firstHalf: path.map(clonePosition),
        secondHalf: [fallbackMidpoint]
    };
};
