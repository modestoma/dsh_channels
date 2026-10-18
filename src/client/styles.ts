/**
 * Settings panel styling. DSH semantic tokens (`--dsw-alias-*`) with neutral
 * fallbacks so the page follows the active theme; only pseudo-classes and
 * responsive rules live here (everything else is inline in the component).
 *
 * @module dsh-channels/client/styles
 */

const STYLE_ATTRIBUTE = 'data-dsh-channels-css'

const CSS = `
.dsh-channels-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;width:100%;max-width:720px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.dsh-channels-cfg__head{display:flex;flex-direction:column;gap:4px}
.dsh-channels-cfg__title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-channels-cfg__desc{margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:18px}
.dsh-channels-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px}
.dsh-channels-cfg__cardHead{display:flex;align-items:center;gap:8px;min-height:20px;flex-wrap:wrap}
.dsh-channels-cfg__cardTitle{font-size:13px;font-weight:500}
.dsh-channels-cfg__cardMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}
.dsh-channels-cfg__statusRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-channels-cfg__badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));font-size:12px;line-height:18px;white-space:nowrap}
.dsh-channels-cfg__dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.dsh-channels-cfg__badge--ok{color:var(--dsw-alias-state-business-primary,#0a7d33);border-color:currentColor}
.dsh-channels-cfg__badge--warn{color:var(--dsw-alias-state-warning-primary,#a15c00);border-color:currentColor}
.dsh-channels-cfg__badge--bad{color:var(--dsw-alias-state-danger-primary,#c62828);border-color:currentColor}
.dsh-channels-cfg__badge--muted{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dsh-channels-cfg__facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 16px}
.dsh-channels-cfg__fact{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-channels-cfg__factLabel{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:16px}
.dsh-channels-cfg__factValue{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-channels-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-channels-cfg__btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dsh-channels-cfg__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsh-channels-cfg__btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#0a67d3);outline-offset:2px}
.dsh-channels-cfg__btn:disabled{color:var(--dsw-alias-label-dimmed,#b0b4ba);cursor:default}
.dsh-channels-cfg__btn--primary{background:var(--dsw-alias-button-primary-fill,#0a67d3);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-channels-cfg__btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#0b5cba)}
.dsh-channels-cfg__btn--danger{color:var(--dsw-alias-state-danger-primary,#c62828);border-color:currentColor}
.dsh-channels-cfg__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;align-items:start}
.dsh-channels-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-channels-cfg__labelRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsh-channels-cfg__label{font-size:12px;color:var(--dsw-alias-label-secondary,#5c6169)}
.dsh-channels-cfg__tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;border:1px dashed currentColor;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}
.dsh-channels-cfg__tag--override{color:var(--dsw-alias-state-business-primary,#0a67d3);border-style:solid}
.dsh-channels-cfg__tag--restart{color:var(--dsw-alias-state-warning-primary,#a15c00)}
.dsh-channels-cfg__help{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;line-height:16px}
.dsh-channels-cfg__input{box-sizing:border-box;width:100%;min-height:28px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.dsh-channels-cfg__input:focus{border-color:var(--dsw-alias-state-business-primary,#0a67d3)}
.dsh-channels-cfg__input--invalid{border-color:var(--dsw-alias-state-danger-primary,#c62828)}
select.dsh-channels-cfg__input{appearance:auto;cursor:pointer}
.dsh-channels-cfg__check{display:inline-flex;align-items:center;gap:6px;min-height:28px;cursor:pointer;font-size:13px}
.dsh-channels-cfg__checkbox{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#0a67d3);cursor:pointer}
.dsh-channels-cfg__fieldError{color:var(--dsw-alias-state-danger-primary,#c62828);font-size:11px;line-height:16px}
.dsh-channels-cfg__notice{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px}
.dsh-channels-cfg__notice--ok{color:var(--dsw-alias-state-business-primary,#0a7d33);background:color-mix(in srgb,currentColor 8%,transparent)}
.dsh-channels-cfg__notice--error{color:var(--dsw-alias-state-danger-primary,#c62828);background:color-mix(in srgb,currentColor 8%,transparent)}
.dsh-channels-cfg__banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-state-warning-primary,#a15c00);color:var(--dsw-alias-state-warning-primary,#a15c00);font-size:12px;line-height:18px}
.dsh-channels-cfg__footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}
.dsh-channels-cfg__spacer{flex:1}
.dsh-channels-cfg__readOnly{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px}
.dsh-channels-cfg__kv{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-channels-cfg__kvKey{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:16px}
.dsh-channels-cfg__kvValue{overflow-wrap:anywhere}
.dsh-channels-cfg__mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dsh-channels-cfg__creds{display:flex;flex-direction:column;gap:6px}
.dsh-channels-cfg__cred{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-channels-cfg__cred .dsh-channels-cfg__input{flex:1 1 240px;min-width:0;width:auto}
.dsh-channels-cfg__error{padding:10px 12px;border:1px solid var(--dsw-alias-state-danger-primary,#c62828);border-radius:10px;color:var(--dsw-alias-state-danger-primary,#c62828);font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:8px}
.dsh-channels-cfg__loading{padding:16px 0;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}
.dsh-channels-cfg__issues{margin:0;padding-left:18px}
@container (max-width:560px){
.dsh-channels-cfg__facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.dsh-channels-cfg__grid,.dsh-channels-cfg__readOnly{grid-template-columns:minmax(0,1fr)}
}
`

/** Append the panel stylesheet once (idempotent across HMR / remounts). */
export function installStyles(): () => void {
  const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTRIBUTE, '')
  style.textContent = CSS
  document.head.append(style)
  return () => {
    style.remove()
  }
}
