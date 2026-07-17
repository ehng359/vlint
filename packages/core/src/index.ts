import { generateLayoutCss, getFileMeta, hasFileBeenUpdated, queryFigmaStyles } from './extraction';
import { getLogger, Logger, setLogger } from './logger';
import { parseManifest } from './manifest';
import {
    applyClassFixes, applyStyleFixes, ClassFix, extractDataFigmaNames,
    extractStyleProps, getDesignAnnotation, getDesignOverrides, StyleFix, StyleProp
} from "./parser";
import { designRefToTheme, figmaValueToUtility, specToClassName } from './tailwind';
import {
    FrameSpec, lintSource, normaliseValue, SpecNode,
    tokenToCssVarName, Violation, ViolationKind,
    violationMessage, violationToClassFix, violationToStyleFix
} from './validate';
import { parseCssModuleClasses } from './cssmodules';
import { ResolvedUtilities, resolveTailwindClasses } from './tailwind';
import { checkFile, CheckResult, checkSource, getFrameSpec, listFrames, loadCssModules, loadDesignRef } from './workspace';

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
    // Per-CSS-prop design token bindings (variable name, or raw id when the
    // Variables API is unreadable)
    tokens?: Record<string, string>;
    // Published style references by kind, e.g. { fill: "Primary/500" }
    styleRefs?: Record<string, string>;
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
    // Figma file version + timestamp at extraction time, for drift direction
    version?: string;
    lastModified?: string;
    // Variable id -> name map when the Variables API was readable
    variables?: Record<string, string>;
    nodes: {
        [frameName: string]: FigmaFrame;
    };
    // CSS file contents attached by queryFigmaStyles
    generatedCss: {
        [frameName: string]: string;
    };
}

export {
    applyClassFixes, applyStyleFixes, checkFile, CheckResult, ClassFix,
    checkSource, designRefToTheme, extractDataFigmaNames, extractStyleProps, FigmaColor,
    FigmaElement,
    FigmaFrame,
    FigmaPage,
    FigmaPaint,
    FigmaTextDetails,
    FigmaVisuals,
    FrameSpec,
    figmaValueToUtility,
    generateLayoutCss,
    getDesignAnnotation,
    getDesignOverrides,
    getFileMeta,
    getFrameSpec,
    getLogger,
    hasFileBeenUpdated,
    lintSource,
    listFrames,
    loadCssModules,
    loadDesignRef,
    parseCssModuleClasses,
    Logger,
    normaliseValue,
    parseManifest,
    queryFigmaStyles,
    ResolvedUtilities,
    resolveTailwindClasses,
    setLogger,
    SpecNode,
    specToClassName,
    StyleFix,
    StyleProp,
    tokenToCssVarName,
    Violation,
    ViolationKind,
    violationMessage,
    violationToClassFix,
    violationToStyleFix
};

