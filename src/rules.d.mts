export interface Violation {
  tier: "hard" | "density";
  rule: string;
  name: string;
  line?: number;
  section?: number;
  evidence: string;
  fix: string;
}

export interface ResponseViolation {
  rule: string;
  name: string;
  fix: string;
}

export declare const PROSE_EXTENSIONS: Set<string>;
export declare const SKIP_MARKERS: string[];

export declare function getExtension(filePath: string): string;
export declare function isProsePath(filePath: string): boolean;
export declare function hasSkipMarker(content: string): boolean;
export declare function stripForScan(content: string): string;
export declare function fenceRanges(content: string): Array<[number, number]>;
export declare function allOccurrencesInsideFences(haystack: string, needle: string): boolean;
export declare function findHardViolations(content: string): Violation[];
export declare function findDensityViolations(content: string): Violation[];
export declare function findAllViolations(content: string): Violation[];
export declare function auditAssistantResponse(responseText: string): ResponseViolation[];
export declare function formatReason(violations: Violation[], filePath: string, mode: string): string;
