// Thin wrapper around the Feather icon set, loaded globally from index.html's
// self-hosted <script> (window.feather). Renders the icon's SVG markup inline
// so it inherits `color`/`font-size` like text would.
declare global {
  interface Window {
    feather?: {
      icons: Record<string, { toSvg: (opts?: Record<string, string | number>) => string }>
    }
  }
}

export function Icon(props: { name: string; size?: number }) {
  const svg = () =>
    window.feather?.icons[props.name]?.toSvg({
      width: props.size ?? 14,
      height: props.size ?? 14,
      'stroke-width': 2,
    }) ?? ''
  return <span class="icon" innerHTML={svg()} />
}
