import type { GlobalThemeOverrides } from "naive-ui";

// A hyper-clean dark "terminal / Notion-dark" palette layered on Naive's dark theme.
// Green is the brand accent (git-graph mark). Tuned for high density + legibility.
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "#3ddc84",
    primaryColorHover: "#56e598",
    primaryColorPressed: "#2cc372",
    primaryColorSuppl: "#3ddc84",
    bodyColor: "#0e0e12",
    cardColor: "#16161d",
    modalColor: "#16161d",
    popoverColor: "#1c1c25",
    tableColor: "#16161d",
    borderColor: "#272730",
    dividerColor: "#222229",
    borderRadius: "10px",
    fontSize: "14px",
    textColorBase: "#e6e6ea",
    textColor1: "#edeef2",
    textColor2: "#b7b7c2",
    textColor3: "#7c7c8a",
    successColor: "#3ddc84",
    warningColor: "#f0a83c",
    errorColor: "#f06a6a",
    infoColor: "#5b9bf0",
  },
  Card: { borderRadius: "14px", paddingMedium: "14px 16px" },
  Button: { borderRadiusMedium: "9px", fontWeightStrong: "600" },
  Tag: { borderRadius: "7px" },
  Drawer: { bodyPadding: "0" },
};
