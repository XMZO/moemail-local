export const DEFAULT_UI_FONT_FAMILY = "var(--font-zpix), sans-serif"

export interface AppearanceConfig {
  fontFamily: string
  advancedEnabled: boolean
  customCss: string
  headHtml: string
  bodyEndHtml: string
  customJs: string
  customJsEnabled: boolean
}

export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = Object.freeze({
  fontFamily: DEFAULT_UI_FONT_FAMILY,
  advancedEnabled: false,
  customCss: "",
  headHtml: "",
  bodyEndHtml: "",
  customJs: "",
  customJsEnabled: false,
})

export const MAX_APPEARANCE_FRAGMENT_BYTES = 128 * 1024
export const MAX_APPEARANCE_TOTAL_BYTES = 256 * 1024
