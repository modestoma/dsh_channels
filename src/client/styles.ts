/**
 * Feishu channel page styling. DSH semantic tokens (`--dsw-alias-*`) with neutral
 * fallbacks, aliased once to local `--dc-*` variables, so the page follows
 * the active theme.
 *
 * @module dsh-channels/client/styles
 */

const STYLE_ATTRIBUTE = 'data-dsh-channels-css'

const CSS = `
.dsh-channels-page{width:100%;height:100%;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;background:var(--dsw-alias-bg-base,#fff)}
.dsh-channels-page__content{box-sizing:border-box;max-width:816px;margin:0 auto;padding:18px clamp(24px,4vw,48px) 48px}
[data-platform='darwin'] .dsh-channels-page__content{padding-top:calc(18px + var(--dsh-frame-top-clearance,0px))}
.dsh-channels-cfg{--dc-fg:var(--dsw-alias-label-primary,#1f2328);--dc-fg2:var(--dsw-alias-label-secondary,#5c6169);--dc-fg3:var(--dsw-alias-label-tertiary,#8a8f98);--dc-dim:var(--dsw-alias-label-dimmed,#b0b4ba);--dc-bg:var(--dsw-alias-bg-base,#fff);--dc-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--dc-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--dc-accent:var(--dsw-alias-state-business-primary,#0a67d3);--dc-ok:var(--dsw-alias-state-success-primary,#0a7d33);--dc-warn:var(--dsw-alias-state-warn-primary,#a15c00);--dc-bad:var(--dsw-alias-state-error-primary,#c62828);--dc-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;container-type:inline-size;display:flex;flex-direction:column;gap:14px;width:100%;max-width:720px;color:var(--dc-fg);font-size:13px;line-height:20px}
.dsh-channels-cfg__panelHead{position:sticky;top:0;z-index:2;display:flex;flex-direction:column;gap:4px;padding:10px 0 6px;background:var(--dc-bg)}
.dsh-channels-cfg__headRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-channels-cfg__title{margin:0 2px 0 0;font-size:20px;font-weight:500;line-height:28px}
.dsh-channels-cfg__meta{color:var(--dc-fg3);font-size:12px}
.dsh-channels-cfg__spacer{flex:1}
.dsh-channels-cfg__mono{font-family:var(--dc-mono);font-size:12px}
.dsh-channels-cfg__pill{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;font-weight:400;white-space:nowrap;color:var(--dc-fg3);background:color-mix(in srgb,currentColor 10%,transparent)}
.dsh-channels-cfg__pill--ok{color:var(--dc-ok)}
.dsh-channels-cfg__pill--warn{color:var(--dc-warn)}
.dsh-channels-cfg__pill--bad{color:var(--dc-bad)}
.dsh-channels-cfg__dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dsh-channels-cfg__tabs{display:flex;align-items:center;gap:18px;border-bottom:1px solid var(--dc-line);overflow-x:auto;scrollbar-width:none}
.dsh-channels-cfg__tab{display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:0;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dc-fg2);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dsh-channels-cfg__tab:hover{color:var(--dc-fg)}
.dsh-channels-cfg__tab[aria-selected="true"]{color:var(--dc-fg);border-bottom-color:currentColor;font-weight:600}
.dsh-channels-cfg__tabCount{padding:0 5px;border-radius:8px;font-size:11px;line-height:16px;font-weight:500;color:var(--dc-warn);background:color-mix(in srgb,var(--dc-warn) 12%,transparent)}
.dsh-channels-cfg__tabDot{width:6px;height:6px;border-radius:50%;background:var(--dc-accent);flex:none}
.dsh-channels-cfg__tabBody{display:flex;flex-direction:column;gap:22px;padding:4px 0 8px}
.dsh-channels-cfg__sec{display:flex;flex-direction:column;gap:6px;margin:0}
.dsh-channels-cfg__secTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dc-fg3);letter-spacing:.02em}
.dsh-channels-cfg__secFoot{margin:0;color:var(--dc-fg3);font-size:12px;line-height:18px}
.dsh-channels-cfg__list{display:flex;flex-direction:column;border:1px solid var(--dc-line);border-radius:10px}
.dsh-channels-cfg__list>*+*{border-top:1px solid var(--dc-line)}
.dsh-channels-cfg__list--warn{border-color:color-mix(in srgb,var(--dc-warn) 45%,transparent);background:color-mix(in srgb,var(--dc-warn) 7%,transparent)}
.dsh-channels-cfg__row{display:flex;align-items:center;gap:16px;padding:11px 14px;min-height:28px}
.dsh-channels-cfg__row--wide{flex-direction:column;align-items:stretch;gap:8px}
.dsh-channels-cfg__rowText{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.dsh-channels-cfg__rowLabel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.dsh-channels-cfg__rowSummary{color:var(--dc-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-channels-cfg__rowCtl{flex:none;display:flex;align-items:center;justify-content:flex-end;min-width:0;max-width:62%}
.dsh-channels-cfg__row--wide .dsh-channels-cfg__rowCtl{max-width:none;justify-content:stretch}
.dsh-channels-cfg__row--wide .dsh-channels-cfg__rowCtl>*{flex:1 1 auto}
.dsh-channels-cfg__details{padding:0 14px 12px;color:var(--dc-fg2);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.dsh-channels-cfg__rowError{padding:0 14px 10px;color:var(--dc-bad);font-size:12px;line-height:18px}
.dsh-channels-cfg__list>.dsh-channels-cfg__rowWrap{border-top-width:0}
.dsh-channels-cfg__list>.dsh-channels-cfg__rowWrap+*{border-top-width:1px}
.dsh-channels-cfg__tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dc-warn);background:color-mix(in srgb,var(--dc-warn) 12%,transparent)}
.dsh-channels-cfg__more{padding:0;border:0;background:none;color:var(--dc-fg3);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;white-space:nowrap}
.dsh-channels-cfg__more:hover{color:var(--dc-fg2)}
.dsh-channels-cfg__link{padding:0;border:0;background:none;color:var(--dc-accent);font:inherit;font-size:13px;cursor:pointer;text-decoration:none;white-space:nowrap}
.dsh-channels-cfg__link:disabled{color:var(--dc-dim);cursor:default}
.dsh-channels-cfg__switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:0;border-radius:10px;background:var(--dc-dim);cursor:pointer;transition:background .15s}
.dsh-channels-cfg__switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.dsh-channels-cfg__switch[aria-checked="true"]{background:var(--dc-accent)}
.dsh-channels-cfg__switch[aria-checked="true"]::after{transform:translateX(14px)}
.dsh-channels-cfg__switch:disabled{opacity:.5;cursor:default}
.dsh-channels-cfg__input{box-sizing:border-box;width:100%;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dc-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.dsh-channels-cfg__input:focus{border-color:var(--dc-accent)}
.dsh-channels-cfg__input--invalid{border-color:var(--dc-bad)}
.dsh-channels-cfg__input--num{width:120px;text-align:right;font-variant-numeric:tabular-nums}
.dsh-channels-cfg__input--text{width:260px}
.dsh-channels-cfg__select{width:220px;appearance:auto;cursor:pointer}
.dsh-channels-cfg__unit{min-width:36px;color:var(--dc-fg3);font-size:12px}
.dsh-channels-cfg__bytes{color:var(--dc-fg3);font-size:12px;white-space:nowrap}
.dsh-channels-cfg__inputRow{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-channels-cfg__inputRow>.dsh-channels-cfg__input:not(.dsh-channels-cfg__input--num){flex:1 1 auto;width:auto}
.dsh-channels-cfg__stringList{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-channels-cfg__stringListItem{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-channels-cfg__fieldError{color:var(--dc-bad);font-size:12px;line-height:18px}
.dsh-channels-cfg__textBad{color:var(--dc-bad)}
.dsh-channels-cfg__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;border:1px solid var(--dc-line);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;text-decoration:none}
.dsh-channels-cfg__btn:hover:not(:disabled){background:var(--dc-hover)}
.dsh-channels-cfg__btn:disabled{color:var(--dc-dim);cursor:default}
.dsh-channels-cfg__btn--primary{background:var(--dsw-alias-button-primary-fill,var(--dc-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-channels-cfg__btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#0b5cba)}
.dsh-channels-cfg__btn--primary:disabled{opacity:.45;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-channels-cfg__btn--ghost{border-color:transparent;color:var(--dc-fg2)}
.dsh-channels-cfg__btn--danger{color:var(--dc-bad)}
.dsh-channels-cfg__btn--remove{color:var(--dc-bad);border-color:color-mix(in srgb,var(--dc-bad) 55%,transparent);background:color-mix(in srgb,var(--dc-bad) 8%,transparent)}
.dsh-channels-cfg__btn--remove:hover:not(:disabled){background:color-mix(in srgb,var(--dc-bad) 15%,transparent)}
.dsh-channels-cfg__btn--remove:disabled{opacity:.5;color:var(--dc-bad)}
.dsh-channels-cfg__btn:focus-visible,.dsh-channels-cfg__tab:focus-visible,.dsh-channels-cfg__switch:focus-visible,.dsh-channels-cfg__link:focus-visible,.dsh-channels-cfg__more:focus-visible{outline:2px solid var(--dc-accent);outline-offset:2px}
.dsh-channels-cfg__notice{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-channels-cfg__notice--ok{color:var(--dc-ok);background:color-mix(in srgb,var(--dc-ok) 9%,transparent)}
.dsh-channels-cfg__notice--error{color:var(--dc-bad);background:color-mix(in srgb,var(--dc-bad) 8%,transparent)}
.dsh-channels-cfg__banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-radius:8px;background:color-mix(in srgb,var(--dc-warn) 12%,transparent);color:var(--dc-fg);font-size:12px;line-height:18px}
.dsh-channels-cfg__bannerText{flex:1;min-width:0}
.dsh-channels-cfg__hero{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dc-line);border-radius:10px}
.dsh-channels-cfg__heroTop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-channels-cfg__heroTop strong{font-size:14px;font-weight:600}
.dsh-channels-cfg__stats{display:flex;gap:28px;flex-wrap:wrap}
.dsh-channels-cfg__stat{display:flex;flex-direction:column}
.dsh-channels-cfg__stat span{color:var(--dc-fg3);font-size:12px}
.dsh-channels-cfg__stat strong{font-size:18px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}
.dsh-channels-cfg__stat strong.dsh-channels-cfg__mono{font-size:14px}
.dsh-channels-cfg__checkIcon{display:grid;place-items:center;flex:none;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;align-self:flex-start;margin-top:1px}
.dsh-channels-cfg__checkIcon--ok{color:var(--dc-ok);background:color-mix(in srgb,var(--dc-ok) 12%,transparent)}
.dsh-channels-cfg__checkIcon--warn{color:var(--dc-warn);background:color-mix(in srgb,var(--dc-warn) 14%,transparent)}
.dsh-channels-cfg__checkIcon--bad{color:var(--dc-bad);background:color-mix(in srgb,var(--dc-bad) 12%,transparent)}
.dsh-channels-cfg__scopeList{margin:0;padding:0 14px 12px 46px;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dc-fg2)}
.dsh-channels-cfg__scopeList li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsh-channels-cfg__scopeList .dsh-channels-cfg__link{font-size:12px}
.dsh-channels-cfg__list>.dsh-channels-cfg__scopeList{border-top-width:0}
.dsh-channels-avatar{box-sizing:border-box;display:grid;place-items:center;flex:none;border-radius:50%;object-fit:cover;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5c6169);line-height:1}
.dsh-channels-cfg__addRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px}
.dsh-channels-cfg__addRow .dsh-channels-cfg__input{flex:1 1 160px;width:auto}
.dsh-channels-cfg__emptyRow{padding:11px 14px;color:var(--dc-fg3);font-size:12px}
.dsh-channels-cfg__saveBar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--dc-line);background:var(--dc-bg)}
.dsh-channels-cfg__saveMsg{flex:1;min-width:0;color:var(--dc-fg2);font-size:12px}
.dsh-channels-cfg__steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.dsh-channels-cfg__step{display:flex;align-items:flex-start;gap:10px}
.dsh-channels-cfg__stepIndex{display:grid;place-items:center;flex:none;width:20px;height:20px;border-radius:50%;color:var(--dc-accent);background:color-mix(in srgb,var(--dc-accent) 12%,transparent);font-size:12px;font-variant-numeric:tabular-nums}
.dsh-channels-cfg__stepBody{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-channels-cfg__stepTitle{font-weight:500}
.dsh-channels-cfg__error{padding:10px 12px;border:1px solid var(--dc-bad);border-radius:10px;color:var(--dc-bad);font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:8px}
.dsh-channels-cfg__loading{padding:16px 0;color:var(--dc-fg3);font-size:12px}
.dsh-channels-origin-chip{display:inline-flex;align-items:center;gap:4px;max-width:180px;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5c6169);font:inherit;font-size:12px;line-height:24px;cursor:pointer;white-space:nowrap}
.dsh-channels-origin-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2328)}
.dsh-channels-origin-chip>svg{flex:none}
.dsh-channels-origin__who{display:inline-flex;align-items:center;gap:6px;vertical-align:middle}
.dsh-channels-origin-chip__text{overflow:hidden;text-overflow:ellipsis}
.dsh-channels-origin{box-sizing:border-box;height:100%;overflow:auto;padding:16px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.dsh-channels-origin__head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.dsh-channels-origin__title{font-size:15px;font-weight:600;line-height:22px;overflow-wrap:anywhere}
.dsh-channels-origin__list{display:flex;flex-direction:column;margin:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px}
.dsh-channels-origin__row{display:flex;gap:12px;padding:9px 12px}
.dsh-channels-origin__row+.dsh-channels-origin__row{border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}
.dsh-channels-origin__row dt{flex:none;width:64px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dsh-channels-origin__row dd{flex:1;min-width:0;margin:0;overflow-wrap:anywhere}
.dsh-channels-origin__mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dsh-channels-origin__muted{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dsh-channels-origin__error{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-state-error-primary,#c62828);font-size:12px}
.dsh-channels-origin__actions{display:flex;align-items:center;gap:14px;margin-top:14px}
.dsh-channels-origin__button{display:inline-flex;align-items:center;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:7px;color:inherit;font-size:13px;text-decoration:none}
.dsh-channels-origin__button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsh-channels-origin__link{padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary,#0a67d3);font:inherit;font-size:13px;cursor:pointer}
.dsh-channels-rec__toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-channels-rec__row{gap:12px;padding:8px 14px}
.dsh-channels-rec__depth1{padding-left:38px}
.dsh-channels-rec__depth2{padding-left:62px}
.dsh-channels-rec__depth1.dsh-channels-rec__session{padding-left:46px}
.dsh-channels-rec__toggle{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-channels-rec__toggle:focus-visible{outline:2px solid var(--dc-accent);outline-offset:2px;border-radius:4px}
.dsh-channels-rec__chevron{flex:none;color:var(--dc-fg3);transition:transform .15s}
.dsh-channels-rec__chevron--open{transform:rotate(90deg)}
.dsh-channels-rec__tag--ok{color:var(--dc-ok);background:color-mix(in srgb,var(--dc-ok) 12%,transparent)}
.dsh-channels-rec__owner{display:flex;align-items:center;gap:10px}
.dsh-channels-rec__workspaceSelect{width:100%;max-width:520px;margin-top:4px}
.dsh-channels-rec__crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;color:var(--dc-fg3);font-size:13px;overflow-wrap:anywhere}
.dsh-channels-rec__crumb{display:inline-flex;align-items:center;gap:4px}
.dsh-channels-rec__crumb [aria-current]{color:var(--dc-fg)}
.dsh-channels-rec__files{max-height:420px;overflow:auto}
.dsh-channels-rec__filesError{padding-top:10px}
.dsh-channels-rec__entry{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:5px 14px;border:0;border-top:1px solid var(--dc-line);background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsh-channels-rec__entry:first-child{border-top:0}
.dsh-channels-rec__entry:hover{background:var(--dc-hover)}
.dsh-channels-rec__entry--selected{background:color-mix(in srgb,var(--dc-accent) 10%,transparent)}
.dsh-channels-rec__entry:focus-visible{outline:2px solid var(--dc-accent);outline-offset:-2px}
.dsh-channels-rec__icon{flex:none;color:var(--dc-fg3)}
.dsh-channels-rec__entryName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-channels-rec__entryMeta{flex:none;color:var(--dc-fg3);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-channels-rec__preview{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dc-line);border-radius:10px}
.dsh-channels-rec__previewHead{display:flex;align-items:center;gap:12px}
.dsh-channels-rec__previewName{overflow-wrap:anywhere}
.dsh-channels-rec__text{margin:0;max-height:480px;overflow:auto;padding:10px 12px;border-radius:7px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));font-family:var(--dc-mono);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-channels-rec__image{max-width:100%;max-height:480px;align-self:flex-start;border-radius:6px;object-fit:contain}
@media (prefers-reduced-motion:reduce){.dsh-channels-rec__chevron{transition:none}}
@media (prefers-reduced-motion:reduce){.dsh-channels-cfg__switch,.dsh-channels-cfg__switch::after{transition:none}}
@container (max-width:560px){
.dsh-channels-cfg__row:not(.dsh-channels-cfg__row--wide){flex-wrap:wrap}
.dsh-channels-cfg__rowCtl{max-width:100%}
.dsh-channels-cfg__select,.dsh-channels-cfg__input--text{width:100%}
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
