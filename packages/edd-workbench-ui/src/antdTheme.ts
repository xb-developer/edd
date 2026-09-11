import type { ThemeConfig } from "antd";

/**
 * Ant Design's theme, expressed in the same design tokens theme.css defines
 * for Tailwind.
 *
 * This is the seam between the two systems, and it is deliberate. antd 6
 * styles its widget INTERNALS through its own CSS-in-JS design system —
 * there is no Tailwind class to reach the inside of a Select's dropdown or
 * a Table's sticky header. So the split is:
 *
 *   - antd tokens (here)  — widget internals: control heights, borders,
 *                           focus rings, the colours antd paints itself
 *   - Tailwind utilities  — everything the app itself lays out: page
 *                           structure, panels, spacing, custom chrome
 *
 * Values are repeated as literals rather than read from CSS custom
 * properties because antd needs them at JS evaluation time to compute
 * derived colours (hover, active, disabled shades). Keep them in step with
 * theme.css — that file is the source of truth, this is its mirror.
 */
const PAPER = "#f5f5f3";
const PANEL = "#ffffff";
const INK = "#1b2130";
const INK_SOFT = "#5b6272";
const LINE = "#e1e3e8";
const NAVY = "#1f2a44";
const SEAL = "#a6362c";
const AMBER = "#b4780c";
// Hover/active shades of NAVY. Stated explicitly rather than left to antd's
// own derivation: antd generates hover states by LIGHTENING a colour, which
// is right for a mid-tone primary but washes out a near-black navy — so
// hover lifts slightly and active goes darker, which is what reads as a
// press on a dark fill.
const NAVY_HOVER = "#2c3a5c";
const NAVY_ACTIVE = "#151d2f";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: NAVY,
    // Pinned to the same shades the plain button uses. Without these, antd
    // derives primary's hover by lightening NAVY while the default button
    // uses NAVY_HOVER below — and since both now render navy, that
    // difference would only ever show up as two buttons hovering to
    // slightly different colours.
    colorPrimaryHover: NAVY_HOVER,
    colorPrimaryActive: NAVY_ACTIVE,
    colorError: SEAL,
    colorWarning: AMBER,
    colorText: INK,
    colorTextSecondary: INK_SOFT,
    colorBorder: LINE,
    colorBorderSecondary: "#edeef1",
    colorBgBase: PAPER,
    colorBgContainer: PANEL,
    fontFamily: '"Inter", system-ui, sans-serif',
    fontFamilyCode: '"IBM Plex Mono", ui-monospace, monospace',
    // 12px — the same size as the document table's body text, which is the
    // reference every other piece of text in the app is matched to. antd's
    // own default is 14px, which visibly loosens every row.
    fontSize: 12,
    borderRadius: 4,
    // The POC's design has essentially flat surfaces; antd's default
    // elevation would read as a different product.
    boxShadow: "none",
    boxShadowSecondary: "0 2px 8px rgba(27, 33, 48, 0.08)",
  },
  components: {
    Table: {
      // 34px rows — the same --spacing-row the rest of the layout sizes
      // against. antd's "small" default is taller.
      cellPaddingBlockSM: 6,
      cellPaddingInlineSM: 8,
      // The table's real font size, and the reference every other piece of
      // text in the app is matched to.
      //
      // This has to be a token. styles.css used to carry
      // `.ant-table { font-size: 12px }`, which never applied: antd emits
      // `.ant-table-wrapper .ant-table.ant-table-small { font-size: … }`
      // (three classes) and simply outranked it. So the table quietly
      // rendered at whatever the global fontSize token happened to be —
      // 13px — while the panels beside it were 12px, which is the size
      // mismatch that was reported.
      cellFontSize: 12,
      cellFontSizeMD: 12,
      cellFontSizeSM: 12,
      headerBg: "#eef1f6",
      headerColor: INK,
      rowSelectedBg: "#eef1f6",
      rowSelectedHoverBg: "#e3e8f1",
      borderColor: LINE,
    },
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",

      // A plain <Button> is a FILLED NAVY button with white text, not
      // antd's stock white-with-dark-text.
      //
      // These `default*` tokens are scoped by antd to `&-color-default`
      // (see its button/style/variant.js), so they change only the plain
      // button. `danger` resolves through colorError and `type="text"`
      // through textTextColor, both in sibling blocks — neither is
      // affected, which is what keeps destructive and quiet actions
      // visually distinct from the ordinary ones.
      defaultBg: NAVY,
      defaultColor: "#fff",
      defaultBorderColor: NAVY,
      defaultHoverBg: NAVY_HOVER,
      defaultHoverColor: "#fff",
      defaultHoverBorderColor: NAVY_HOVER,
      defaultActiveBg: NAVY_ACTIVE,
      defaultActiveColor: "#fff",
      defaultActiveBorderColor: NAVY_ACTIVE,
      // Disabled has to stop looking like a filled navy button, or
      // "disabled" and "available" differ only by a slight text fade.
      defaultBgDisabled: "#e8eaee",

      // The topbar buttons sit ON the navy bar, where a navy fill would be
      // invisible — they use `ghost`, which antd routes to these two
      // tokens instead. Transparent with a white border and white text:
      // still white-on-dark-blue, just with the bar supplying the blue.
      defaultGhostColor: "#fff",
      defaultGhostBorderColor: "rgba(255, 255, 255, 0.5)",
    },
    Modal: {
      titleFontSize: 14,
    },
  },
};
