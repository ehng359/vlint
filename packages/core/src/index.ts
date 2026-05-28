import { hasFileBeenUpdated, queryFigmaStyles } from './extraction';
import { applyStyleFixes, extractDataFigmaNames, StyleFix } from "./parser";

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
    text: string;
    style: {
        fontFamily: string;
        fontWeight: number;
        fontSize: number;
        textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
        lineHeightPx: number;
        letterSpacing: number;
    };
}

interface FigmaVisuals {
    fills: FigmaPaint[];
    strokes: FigmaPaint[];
    strokeWeight: number;
    strokeAlign: 'CENTER' | 'INSIDE' | 'OUTSIDE';
    individualStrokeWeights: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    } | null;
    effects: any[];
}

// Represents a translated node as it appears in DESIGN_REF.json —
// raw Figma properties have been mapped to CSS-equivalent values
interface FigmaElement {
    // ── Identity ────────────────────────────────────────────────────────────
    id: string;
    name: string;
    type: 'FRAME' | 'TEXT' | 'INSTANCE' | 'VECTOR' | 'RECTANGLE';
    visible?: boolean;

    // ── Box model (content-box values, padding already subtracted) ───────────
    width?: string;          // e.g. "198px"
    height?: string;         // e.g. "64px"
    flex?: string;           // "1" when layoutGrow === 1
    alignSelf?: string;      // "stretch" when layoutAlign === STRETCH

    // ── Spacing ──────────────────────────────────────────────────────────────
    padding?: string;        // e.g. "20px 24px"
    gap?: string;            // e.g. "16px"
    borderRadius?: string;   // e.g. "12px"

    // ── Color ────────────────────────────────────────────────────────────────
    color?: string;          // TEXT nodes only — from fills
    backgroundColor?: string;

    // ── Border / shadow ──────────────────────────────────────────────────────
    border?: string;
    borderTop?: string;
    borderRight?: string;
    borderBottom?: string;
    borderLeft?: string;
    boxShadow?: string;      // used for INSIDE strokes

    // ── Auto-layout ──────────────────────────────────────────────────────────
    display?: 'flex';
    flexDirection?: 'row' | 'column';
    alignItems?: string;
    justifyContent?: string;

    // ── Typography (TEXT nodes only) ─────────────────────────────────────────
    fontFamily?: string;
    fontSize?: string;       // e.g. "13px"
    fontWeight?: number;
    lineHeight?: string;     // e.g. "18px"
    letterSpacing?: string;  // e.g. "0.04px"
    textAlign?: string;

    // ── Figma metadata (never written to CSS) ────────────────────────────────
    layoutAlign?: 'STRETCH' | 'INHERIT';
    layoutGrow?: 0 | 1;
    minWidth?: number | null;
    maxWidth?: number | null;
    variables?: Record<string, any>;
    resolvedDesignTokens?: {
        component?: Record<string, any>;
        componentSet?: Record<string, any>;
        styles?: Record<string, any>;
    };
}

interface FigmaFrame {
    id: string;
    type: string;
    width?: string;
    height?: string;
    display?: 'flex';
    flexDirection?: 'row' | 'column';
    gap?: string;
    padding?: string;
    backgroundColor?: string;
    children: { [componentName: string]: FigmaElement };
}

interface FigmaPage {
    extractedAt: string;
    nodes: {
        [frameName: string]: FigmaFrame;
    };
    // CSS file contents attached by queryFigmaStyles
    generatedCss: {
        [frameName: string]: string;
    };
    typographyCss: string;
}

export {
    applyStyleFixes, extractDataFigmaNames, FigmaColor,
    FigmaElement,
    FigmaFrame,
    FigmaPage,
    FigmaPaint,
    FigmaTextDetails,
    FigmaVisuals,
    hasFileBeenUpdated,
    queryFigmaStyles,
    StyleFix
};

