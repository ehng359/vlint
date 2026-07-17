import { FigmaPage } from './index';

export function queryFigmaStyles(
    page: string,
    fileKey: string,
    accessToken: string
): Promise<FigmaPage>;

export function hasFileBeenUpdated(
    fileKey: string,
    accessToken: string
): Promise<boolean>;

export function generateLayoutCss(
    frameName: string,
    childrenMap: Record<string, any>,
    breakpointFrames?: Record<string, Record<string, any>>
): string;

export function mapFigmaToCss(node: Record<string, any>): Record<string, any>;

export function getFileMeta(
    fileKey: string,
    accessToken: string
): Promise<{ version: string; lastModified: string }>;

export const SPEC_METADATA_KEYS: Set<string>;
export const FIGMA_METADATA_KEYS: Set<string>;
export const CSS_DEFAULTS: Record<string, string>;