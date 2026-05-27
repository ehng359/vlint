import { hasFileBeenUpdated, queryFigmaStyles } from './extraction';
import { applyStyleFixes, extractStyles, StyleFix } from "./parser";
interface FigmaColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

interface FigmaPaint {
    type: 'SOLID' | 'GRADIENT_LINEAR' | 'IMAGE';
    visible?: boolean;
    opacity?: number;
    color?: FigmaColor;
}

interface FigmaTextDetails {
    characters: string;
    style: {
        fontFamily: string;
        fontWeight: number;
        fontSize: number;
        textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
        lineHeightPx: number;
        letterSpacing: number;
    };
}

interface FigmaElement {
    id: string;
    name: string;
    type: 'FRAME' | 'TEXT' | 'INSTANCE' | 'VECTOR' | 'RECTANGLE';
    visible: boolean;

    // Layout
    width: number;
    height: number;
    layoutAlign: 'STRETCH' | 'INHERIT';
    layoutGrow: 0 | 1;

    // Styling
    visuals: {
        fills: FigmaPaint[];
        strokes: FigmaPaint[];
        strokeWeight: number;
        cornerRadius?: number;
        effects: any[]; // Shadows, blurs
    };

    // Text specific
    textDetails: FigmaTextDetails | null;

    // Tokens/Styles linked to the Figma Library
    resolvedDesignTokens: {
        component?: string;    // ID of the component
        styles?: Record<string, string>; // e.g., { "fill": "token-id" }
    };
}

interface FigmaFrame {
    id: string;
    type: string;
    layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
    itemSpacing: number;
    padding: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
    borderRadius: number;
    visualDimensions: {
        width: number;
        height: number;
    };
    children: { [componentName: string]: FigmaElement };
}

interface FigmaPage {
    extractedAt: string;
    nodes: {
        [frameName: string]: FigmaFrame;
    };
}

export { applyStyleFixes, extractStyles, FigmaColor, FigmaElement, FigmaFrame, FigmaPage, FigmaPaint, hasFileBeenUpdated, queryFigmaStyles, StyleFix };

