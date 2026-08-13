"use client"

import { useEffect } from "react"

interface CustomAppearanceInjectorProps {
  customCss: string
  headHtml: string
  bodyEndHtml: string
  customJs: string
  customJsEnabled: boolean
}

function appendHtml(target: HTMLElement, html: string, marker: string) {
  if (!html) return [] as Node[]
  const template = document.createElement("template")
  template.innerHTML = html
  const nodes = Array.from(template.content.childNodes)
  for (const node of nodes) {
    if (node instanceof Element) node.setAttribute("data-moemail-custom-appearance", marker)
    target.appendChild(node)
  }
  return nodes
}

export function CustomAppearanceInjector({
  customCss,
  headHtml,
  bodyEndHtml,
  customJs,
  customJsEnabled,
}: CustomAppearanceInjectorProps) {
  useEffect(() => {
    const injected: Node[] = []

    if (customCss) {
      const style = document.createElement("style")
      style.dataset.moemailCustomAppearance = "css"
      style.textContent = customCss
      document.head.appendChild(style)
      injected.push(style)
    }

    injected.push(...appendHtml(document.head, headHtml, "head"))
    injected.push(...appendHtml(document.body, bodyEndHtml, "body-end"))

    if (customJsEnabled && customJs) {
      const script = document.createElement("script")
      script.dataset.moemailCustomAppearance = "javascript"
      script.textContent = customJs
      document.body.appendChild(script)
      injected.push(script)
    }

    return () => {
      for (const node of injected.reverse()) node.parentNode?.removeChild(node)
    }
  }, [bodyEndHtml, customCss, customJs, customJsEnabled, headHtml])

  return null
}
