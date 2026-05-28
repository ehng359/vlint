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
    childrenMap: Record<string, any>
): string;

export function generateTypographyCss(
    registry: Record<string, any>
): string;