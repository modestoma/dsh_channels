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
.dsh-channels-cfg__headRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:36px}
.dsh-channels-cfg__logo{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:9px;color:var(--dc-accent);background:color-mix(in srgb,var(--dc-accent) 12%,transparent)}
.dsh-channels-cfg__title{margin:0 4px 0 2px;font-size:20px;font-weight:600;line-height:28px;letter-spacing:.01em}
.dsh-channels-cfg__meta{color:var(--dc-fg3);font-size:12px}
.dsh-channels-cfg__spacer{flex:1}
.dsh-channels-cfg__mono{font-family:var(--dc-mono);font-size:12px}
.dsh-channels-cfg__pill{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;font-weight:400;white-space:nowrap;color:var(--dc-fg3);background:color-mix(in srgb,currentColor 10%,transparent)}
.dsh-channels-cfg__pill--ok{color:var(--dc-ok)}
.dsh-channels-cfg__pill--warn{color:var(--dc-warn)}
.dsh-channels-cfg__pill--bad{color:var(--dc-bad)}
.dsh-channels-cfg__dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dsh-channels-cfg__tabs{display:flex;align-items:center;gap:22px;border-bottom:1px solid var(--dc-line);overflow-x:auto;scrollbar-width:none}
.dsh-channels-cfg__tab{display:inline-flex;align-items:center;gap:5px;min-height:38px;padding:0 1px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dc-fg2);font:inherit;font-size:13.5px;cursor:pointer;white-space:nowrap;transition:color .12s,border-color .12s}
.dsh-channels-cfg__tab:hover{color:var(--dc-fg);border-bottom-color:var(--dc-line)}
.dsh-channels-cfg__tab[aria-selected="true"]{color:var(--dc-fg);border-bottom-color:var(--dc-accent);font-weight:600}
.dsh-channels-cfg__tabCount{padding:0 5px;border-radius:8px;font-size:11px;line-height:16px;font-weight:500;color:var(--dc-warn);background:color-mix(in srgb,var(--dc-warn) 12%,transparent)}
.dsh-channels-cfg__tabDot{width:6px;height:6px;border-radius:50%;background:var(--dc-accent);flex:none}
.dsh-channels-cfg__tabBody{display:flex;flex-direction:column;gap:22px;padding:4px 0 8px}
.dsh-channels-cfg__sec{display:flex;flex-direction:column;gap:6px;margin:0}
.dsh-channels-cfg__secTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dc-fg3);letter-spacing:.02em}
.dsh-channels-cfg__secFoot{margin:0;color:var(--dc-fg3);font-size:12px;line-height:18px}
.dsh-channels-cfg__list{display:flex;flex-direction:column;border:1px solid var(--dc-line);border-radius:12px;background:var(--dc-bg)}
.dsh-channels-cfg__list>*+*{border-top:1px solid var(--dc-line)}
.dsh-channels-cfg__list--warn{border-color:color-mix(in srgb,var(--dc-warn) 45%,transparent);background:color-mix(in srgb,var(--dc-warn) 7%,transparent)}
.dsh-channels-cfg__row{display:flex;align-items:center;gap:16px;padding:12px 16px;min-height:28px}
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
.dsh-channels-cfg__input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dc-line);border-radius:8px;transition:border-color .15s,box-shadow .15s;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.dsh-channels-cfg__input:focus{border-color:var(--dc-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dc-accent) 14%,transparent)}
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
.dsh-channels-cfg__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dc-line);border-radius:8px;transition:background .12s,border-color .12s,color .12s;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;text-decoration:none}
.dsh-channels-cfg__btn:hover:not(:disabled){background:var(--dc-hover)}
.dsh-channels-cfg__btn:disabled{color:var(--dc-dim);cursor:default}
.dsh-channels-cfg__btn--primary{background:var(--dsw-alias-button-primary-fill,var(--dc-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-channels-cfg__btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#0b5cba)}
.dsh-channels-cfg__btn--primary:disabled{opacity:.45;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-channels-cfg__btn--ghost{border-color:transparent;color:var(--dc-fg2)}
.dsh-channels-cfg__btn--danger{color:var(--dc-bad)}
.dsh-channels-cfg__btn--remove{color:var(--dc-bad);border-color:var(--dc-line);background:transparent}
.dsh-channels-cfg__btn--remove:hover:not(:disabled){border-color:color-mix(in srgb,var(--dc-bad) 45%,transparent);background:color-mix(in srgb,var(--dc-bad) 8%,transparent)}
.dsh-channels-cfg__btn--remove:disabled{opacity:.5;color:var(--dc-bad)}
.dsh-channels-cfg__btn:focus-visible,.dsh-channels-cfg__tab:focus-visible,.dsh-channels-cfg__switch:focus-visible,.dsh-channels-cfg__link:focus-visible,.dsh-channels-cfg__more:focus-visible{outline:2px solid var(--dc-accent);outline-offset:2px}
.dsh-channels-cfg__notice{padding:9px 12px;border-radius:10px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-channels-cfg__notice--ok{color:var(--dc-ok);background:color-mix(in srgb,var(--dc-ok) 9%,transparent)}
.dsh-channels-cfg__notice--error{color:var(--dc-bad);background:color-mix(in srgb,var(--dc-bad) 8%,transparent)}
.dsh-channels-cfg__banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:10px;background:color-mix(in srgb,var(--dc-warn) 12%,transparent);color:var(--dc-fg);font-size:12px;line-height:18px}
.dsh-channels-cfg__bannerText{flex:1;min-width:0}
.dsh-channels-cfg__hero{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:1px solid var(--dc-line);border-radius:12px;background:linear-gradient(180deg,color-mix(in srgb,var(--dc-accent) 4%,var(--dc-bg)),var(--dc-bg) 70%)}
.dsh-channels-cfg__heroTop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-channels-cfg__heroTop strong{font-size:14px;font-weight:600}
.dsh-channels-cfg__stats{display:flex;gap:28px;flex-wrap:wrap}
.dsh-channels-cfg__stat{display:flex;flex-direction:column}
.dsh-channels-cfg__stat span{color:var(--dc-fg3);font-size:12px}
.dsh-channels-cfg__stat strong{font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}
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
.dsh-channels-cfg__error{padding:12px 14px;border:1px solid color-mix(in srgb,var(--dc-bad) 45%,transparent);background:color-mix(in srgb,var(--dc-bad) 5%,transparent);border-radius:12px;color:var(--dc-bad);font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:8px}
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
.dsh-channels-rec{gap:18px}
.dsh-channels-rec__toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-channels-rec__search{display:flex;align-items:center;gap:8px;flex:1 1 240px;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dc-line);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dc-fg3);transition:border-color .15s,box-shadow .15s}
.dsh-channels-rec__search:focus-within{border-color:var(--dc-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dc-accent) 14%,transparent)}
.dsh-channels-rec__searchInput{flex:1;min-width:0;height:100%;padding:0;border:0;outline:none;background:transparent;color:var(--dc-fg);font:inherit;font-size:13px}
.dsh-channels-rec__searchInput::placeholder{color:var(--dc-fg3)}
.dsh-channels-rec__totals{color:var(--dc-fg3);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-channels-rec__iconBtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:32px;height:32px;padding:0 8px;border:1px solid var(--dc-line);border-radius:8px;background:transparent;color:var(--dc-fg2);font:inherit;font-size:13px;cursor:pointer;transition:background .15s,color .15s}
.dsh-channels-rec__iconBtn:hover:not(:disabled){background:var(--dc-hover);color:var(--dc-fg)}
.dsh-channels-rec__iconBtn:disabled{color:var(--dc-dim);cursor:default}
.dsh-channels-rec__iconBtn--labelled{padding:0 12px 0 10px;height:30px}
.dsh-channels-rec__spin{animation:dsh-channels-spin .8s linear infinite}
@keyframes dsh-channels-spin{to{transform:rotate(360deg)}}
.dsh-channels-rec__secTitle{display:flex;align-items:center;gap:6px}
.dsh-channels-rec__secCount{padding:0 6px;border-radius:8px;background:var(--dc-hover);color:var(--dc-fg3);font-size:11px;line-height:16px;font-weight:500;font-variant-numeric:tabular-nums}
.dsh-channels-rec__empty{padding:28px 20px;border:1px dashed var(--dc-line);border-radius:12px;color:var(--dc-fg3);font-size:13px;line-height:20px;text-align:center}
.dsh-channels-rec__muted{padding:12px 14px;color:var(--dc-fg3);font-size:12px}
.dsh-channels-rec__card{border:1px solid var(--dc-line);border-radius:12px;background:var(--dc-bg);overflow:hidden;transition:box-shadow .15s,border-color .15s}
.dsh-channels-rec__card+.dsh-channels-rec__card{margin-top:8px}
.dsh-channels-rec__card--open{box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 14px rgba(0,0,0,.05)}
.dsh-channels-rec__head{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0;width:100%;padding:10px 14px 10px 10px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .12s}
.dsh-channels-rec__head:hover{background:var(--dc-hover)}
.dsh-channels-rec__head:focus-visible,.dsh-channels-rec__session:focus-visible,.dsh-channels-rec__filesBtn:focus-visible,.dsh-channels-rec__iconBtn:focus-visible{outline:2px solid var(--dc-accent);outline-offset:-2px;border-radius:8px}
.dsh-channels-rec__head--group{padding-top:12px;padding-bottom:12px}
.dsh-channels-rec__chevron{flex:none;color:var(--dc-fg3);transition:transform .18s ease}
.dsh-channels-rec__head[aria-expanded="true"]>.dsh-channels-rec__chevron{transform:rotate(90deg);color:var(--dc-fg2)}
.dsh-channels-rec__headText{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.dsh-channels-rec__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsh-channels-rec__head--group .dsh-channels-rec__name{font-size:14px;font-weight:600}
.dsh-channels-rec__meta{color:var(--dc-fg3);font-size:12px;line-height:18px}
.dsh-channels-rec__time{flex:none;color:var(--dc-fg3);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-channels-rec__members{border-top:1px solid var(--dc-line);background:color-mix(in srgb,var(--dc-fg) 1.5%,transparent);padding:4px 0}
.dsh-channels-rec__members .dsh-channels-rec__head{padding-left:28px}
.dsh-channels-rec__user+.dsh-channels-rec__user{border-top:1px solid color-mix(in srgb,var(--dc-line) 60%,transparent)}
.dsh-channels-rec__members .dsh-channels-rec__user+.dsh-channels-rec__user{border-top:0}
.dsh-channels-rec__userRow{display:flex;align-items:center;padding-right:10px}
.dsh-channels-rec__filesBtn{display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;margin-left:4px;padding:0 9px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dc-fg2);font:inherit;font-size:12px;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.dsh-channels-rec__filesBtn:hover:not(:disabled){border-color:var(--dc-line);background:var(--dc-bg);color:var(--dc-accent)}
.dsh-channels-rec__filesBtn:disabled{color:var(--dc-dim);cursor:default}
.dsh-channels-rec__sessions{list-style:none;margin:0 62px 8px 44px;padding:2px 0 2px 12px;border-left:1px solid var(--dc-line)}
.dsh-channels-rec__members .dsh-channels-rec__sessions{margin-left:62px}
.dsh-channels-rec__session{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:background .12s}
.dsh-channels-rec__session:hover:not(:disabled){background:var(--dc-hover)}
.dsh-channels-rec__session:disabled{cursor:default}
.dsh-channels-rec__status{flex:none;width:7px;height:7px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--dc-dim)}
.dsh-channels-rec__status--bound{background:var(--dc-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--dc-ok) 18%,transparent)}
.dsh-channels-rec__sessionTitle{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-channels-rec__sessionTitle--untitled{color:var(--dc-fg3);font-style:italic}
.dsh-channels-rec__chip{flex:none;padding:0 6px;border-radius:5px;font-size:11px;line-height:17px;color:var(--dc-fg2);background:var(--dc-hover);white-space:nowrap}
.dsh-channels-rec__chip--ok{color:var(--dc-ok);background:color-mix(in srgb,var(--dc-ok) 11%,transparent)}
.dsh-channels-rec__session>.dsh-channels-rec__time{margin-left:auto;padding-left:8px}
.dsh-channels-rec__open{display:inline-flex;flex:none;width:14px;margin-right:-22px;color:var(--dc-accent);opacity:0;transition:opacity .12s}
.dsh-channels-rec__session:hover:not(:disabled)>.dsh-channels-rec__open,.dsh-channels-rec__session:focus-visible>.dsh-channels-rec__open{opacity:1}
.dsh-channels-fb__header{display:flex;align-items:center;gap:12px;min-width:0}
.dsh-channels-fb__owner{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dsh-channels-fb__ownerName{font-size:15px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-channels-fb__ownerGroup{color:var(--dc-fg3);font-weight:400}
.dsh-channels-fb__path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dc-fg3);font-family:var(--dc-mono);font-size:11.5px}
.dsh-channels-fb__workspaceSelect{max-width:100%;height:26px;padding:0 6px;border:1px solid var(--dc-line);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dc-fg2);font-family:var(--dc-mono);font-size:11.5px}
.dsh-channels-fb{container-type:inline-size;display:grid;grid-template-columns:minmax(0,1fr);border:1px solid var(--dc-line);border-radius:12px;overflow:hidden;background:var(--dc-bg)}
@container (min-width:600px){
.dsh-channels-fb{grid-template-columns:minmax(210px,36%) minmax(0,1fr);height:min(600px,calc(100vh - 280px));min-height:360px}
.dsh-channels-fb__pane--list{border-right:1px solid var(--dc-line);border-bottom:0}
}
.dsh-channels-fb__pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.dsh-channels-fb__pane--list{border-bottom:1px solid var(--dc-line);background:color-mix(in srgb,var(--dc-fg) 1.5%,transparent)}
.dsh-channels-fb__crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;min-height:40px;padding:6px 10px;border-bottom:1px solid var(--dc-line);font-size:12.5px}
.dsh-channels-fb__crumbItem{display:inline-flex;align-items:center;gap:2px;min-width:0}
.dsh-channels-fb__crumb{max-width:160px;padding:2px 6px;border:0;border-radius:5px;background:none;color:var(--dc-fg2);font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.dsh-channels-fb__crumb:hover{background:var(--dc-hover);color:var(--dc-fg)}
.dsh-channels-fb__crumbCurrent{max-width:200px;padding:2px 6px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-channels-fb__crumbSep{color:var(--dc-dim)}
.dsh-channels-fb__entries{flex:1;min-height:0;max-height:360px;overflow:auto;padding:4px}
@container (min-width:600px){.dsh-channels-fb__entries{max-height:none}}
.dsh-channels-fb__entry{display:flex;align-items:center;gap:9px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:7px;background:none;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsh-channels-fb__entry:hover{background:var(--dc-hover)}
.dsh-channels-fb__entry:focus-visible{outline:2px solid var(--dc-accent);outline-offset:-2px}
.dsh-channels-fb__entry--selected,.dsh-channels-fb__entry--selected:hover{background:color-mix(in srgb,var(--dc-accent) 12%,transparent);color:var(--dc-fg)}
.dsh-channels-fb__entry--parent{color:var(--dc-fg2)}
.dsh-channels-fb__parentGlyph{display:inline-flex;justify-content:center;width:16px;flex:none;color:var(--dc-fg3);font-family:var(--dc-mono);font-size:12px;letter-spacing:-1px}
.dsh-channels-fb__entryName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-channels-fb__entryMeta{flex:none;color:var(--dc-fg3);font-size:11.5px;font-variant-numeric:tabular-nums}
.dsh-channels-rec__icon{flex:none;color:var(--dc-fg3)}
.dsh-channels-rec__icon--dir{color:color-mix(in srgb,var(--dc-accent) 60%,transparent)}
.dsh-channels-rec__icon--image{color:#7c5cff}
.dsh-channels-rec__icon--code{color:#0f9d8a}
.dsh-channels-rec__icon--archive{color:#c27a00}
.dsh-channels-fb__placeholder{padding:14px 10px;color:var(--dc-fg3);font-size:12px}
.dsh-channels-fb__placeholder--error{color:var(--dc-bad)}
.dsh-channels-fb__pane--preview{min-height:240px}
.dsh-channels-fb__blank{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:200px;padding:24px;color:var(--dc-fg3);font-size:13px;text-align:center}
.dsh-channels-fb__blank--binary .dsh-channels-rec__icon{width:36px;height:36px}
.dsh-channels-fb__preview{display:flex;flex-direction:column;flex:1;min-height:0}
.dsh-channels-fb__previewHead{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;border-bottom:1px solid var(--dc-line)}
.dsh-channels-fb__previewTitle{display:flex;flex-direction:column;flex:1;min-width:0}
.dsh-channels-fb__previewName{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-channels-fb__previewFacts{color:var(--dc-fg3);font-size:11.5px;font-variant-numeric:tabular-nums}
.dsh-channels-fb__alert{margin:10px 14px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dc-bad) 8%,transparent);color:var(--dc-bad);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-channels-fb__note{padding:6px 14px;border-bottom:1px solid var(--dc-line);background:color-mix(in srgb,var(--dc-warn) 8%,transparent);color:var(--dc-warn);font-size:12px}
.dsh-channels-fb__textWrap{display:flex;flex-direction:column;flex:1;min-height:0}
.dsh-channels-fb__text{flex:1;min-height:0;max-height:480px;margin:0;padding:10px 0;overflow:auto;background:var(--dsw-alias-bg-layer-1,color-mix(in srgb,var(--dc-fg) 2%,transparent));font-family:var(--dc-mono);font-size:12px;line-height:19px;tab-size:4;counter-reset:dsh-line}
@container (min-width:600px){.dsh-channels-fb__text{max-height:none}}
.dsh-channels-fb__text>code{display:block;min-width:max-content;font:inherit}
.dsh-channels-fb__line{display:block;padding-right:16px;white-space:pre}
.dsh-channels-fb__line::before{counter-increment:dsh-line;content:counter(dsh-line);display:inline-block;width:3.2em;margin-right:14px;padding-right:10px;border-right:1px solid var(--dc-line);color:var(--dc-dim);text-align:right;user-select:none}
.dsh-channels-fb__imageWrap{display:flex;flex:1;align-items:center;justify-content:center;min-height:200px;padding:16px;overflow:auto;background-color:var(--dc-bg);background-image:linear-gradient(45deg,var(--dc-hover) 25%,transparent 25%,transparent 75%,var(--dc-hover) 75%),linear-gradient(45deg,var(--dc-hover) 25%,transparent 25%,transparent 75%,var(--dc-hover) 75%);background-size:16px 16px;background-position:0 0,8px 8px}
.dsh-channels-fb__image{max-width:100%;max-height:100%;border-radius:4px;box-shadow:0 1px 6px rgba(0,0,0,.12);object-fit:contain}
@media (prefers-reduced-motion:reduce){.dsh-channels-rec__chevron,.dsh-channels-rec__spin{transition:none;animation:none}}
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
