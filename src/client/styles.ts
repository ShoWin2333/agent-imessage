const border='var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 14%, transparent))'
const borderStrong='var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 24%, transparent))'
const brand='var(--dsw-alias-brand-primary, #3367dc)'
const onBrand='var(--dsw-alias-brand-on-primary, #fff)'
const danger='var(--dsw-alias-state-error-primary, #c94545)'
const surface='var(--dsw-alias-bg-layer-1, transparent)'
const secondary='var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 62%, transparent))'

export const styles = `
.dsh-channel-panel{color:inherit;font:inherit;max-width:960px;padding:4px 0 32px;--cp-radius:10px;--cp-gap:12px}
.dsh-channel-panel *{box-sizing:border-box}
.dsh-channel-panel h2{font-size:20px;line-height:1.35;margin:0 0 6px;font-weight:600;letter-spacing:-.01em}
.dsh-channel-panel h3{font-size:14px;line-height:1.4;margin:0;font-weight:600}
.dsh-channel-muted{color:${secondary};font-size:12px;line-height:1.6;max-width:72ch;margin:6px 0}
.dsh-channel-subtle{color:${secondary};font-size:11px}

/* ---------- controls ---------- */
.dsh-channel-panel button,.dsh-channel-panel input,.dsh-channel-panel select{font:inherit;color:inherit;border:1px solid ${border};border-radius:8px;background:transparent;padding:7px 12px;min-height:34px}
.dsh-channel-panel button{font-size:13px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.dsh-channel-panel button:hover:not(:disabled){background:color-mix(in srgb,currentColor 6%,transparent);border-color:${borderStrong}}
.dsh-channel-panel button:disabled{opacity:.45;cursor:not-allowed}
.dsh-channel-panel button:focus-visible,.dsh-channel-panel input:focus-visible,.dsh-channel-panel select:focus-visible{outline:2px solid ${brand};outline-offset:2px}
.dsh-channel-panel input,.dsh-channel-panel select{font-size:13px;min-height:34px;background:${surface}}
.dsh-channel-panel input:focus,.dsh-channel-panel select:focus{border-color:${brand}}
.dsh-channel-panel input[readonly]{opacity:.7}
.dsh-channel-panel .dsh-channel-primary{background:${brand};color:${onBrand};border-color:${brand};font-weight:500}
.dsh-channel-panel .dsh-channel-primary:hover:not(:disabled){background:color-mix(in srgb,${brand} 88%,#000);border-color:color-mix(in srgb,${brand} 88%,#000)}
.dsh-channel-panel .dsh-channel-danger{color:${danger};border-color:color-mix(in srgb,${danger} 32%,transparent)}
.dsh-channel-panel .dsh-channel-danger:hover:not(:disabled){background:color-mix(in srgb,${danger} 10%,transparent);border-color:${danger}}
.dsh-channel-panel .dsh-channel-ghost{border-color:transparent;color:${secondary};padding-left:9px;padding-right:9px}
.dsh-channel-panel .dsh-channel-ghost:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent);border-color:transparent;color:inherit}
.dsh-channel-panel .dsh-channel-add{border-style:dashed;color:${secondary};padding:6px 11px;min-height:32px;font-size:12px}
.dsh-channel-panel .dsh-channel-add:hover:not(:disabled){color:inherit;border-style:solid}
/* Native checkboxes must not inherit the text-field box. */
.dsh-channel-panel input[type=checkbox],.dsh-channel-panel input[type=radio]{width:15px;height:15px;min-height:0;padding:0;margin:2px 0 0;flex:none;border:1px solid ${borderStrong};border-radius:4px;background:transparent;accent-color:${brand}}
.dsh-channel-options{display:flex;flex-direction:column;gap:10px;margin:6px 0 10px}
.dsh-channel-option{display:flex;align-items:flex-start;gap:9px;font-size:13px;font-weight:400;color:inherit;line-height:1.5;cursor:pointer;min-width:0}
.dsh-channel-option>span{min-width:0;overflow-wrap:anywhere}
.dsh-channel-inline{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:400;color:inherit;line-height:1.5}
.dsh-channel-inline>span{flex:none}
.dsh-channel-inline input[type=number]{width:92px;flex:none;min-height:32px;padding:4px 8px}
.dsh-channel-stack{display:flex;flex-direction:column;gap:14px;max-width:440px}

/* ---------- layout ---------- */
.dsh-channel-toolbar,.dsh-channel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 0}
.dsh-channel-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-channel-actions>.dsh-channel-muted{margin:0}
.dsh-channel-card{border:1px solid ${border};border-radius:var(--cp-radius);padding:16px;margin:12px 0;background:${surface}}
.dsh-channel-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.dsh-channel-field{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:500;color:${secondary};min-width:0}
.dsh-channel-field input,.dsh-channel-field select{width:100%;font-size:13px;font-weight:400;color:inherit}
.dsh-channel-wide{grid-column:1/-1}
.dsh-channel-path{display:flex;gap:8px}
.dsh-channel-path input{flex:1;min-width:0}
.dsh-channel-path-text{font-size:12px;overflow-wrap:anywhere;line-height:1.6}
.dsh-channel-panel summary{cursor:pointer;padding:12px 0;font-size:13px;color:${secondary}}
.dsh-channel-panel summary:hover{color:inherit}
.dsh-channel-panel details .dsh-channel-grid{padding:4px 0 8px}
.dsh-channel-panel details .dsh-channel-options{padding:4px 0 2px}
.dsh-channel-panel fieldset:disabled{opacity:.6}
.dsh-channel-panel fieldset{border:0;padding:0;margin:0;min-width:0}
.dsh-channel-footer{margin-top:16px;padding-top:12px;border-top:1px solid ${border};display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsh-channel-footer>.dsh-channel-muted{margin:0}

/* ---------- agent rail ---------- */
.dsh-agent-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;margin-top:18px;align-items:start}
.dsh-agent-detail{min-width:0}
.dsh-agent-tabs{display:flex;flex-direction:column;align-items:stretch;align-self:start;gap:4px;margin:0;padding-right:20px;border-right:1px solid ${border}}
.dsh-agent-tabs button{display:flex;width:100%;min-width:0;justify-content:space-between;align-items:center;gap:12px;text-align:left;border-color:transparent;background:transparent;padding:9px 10px}
.dsh-agent-tabs button:hover:not(:disabled){background:color-mix(in srgb,currentColor 6%,transparent)}
.dsh-agent-tabs button[aria-pressed=true]{background:color-mix(in srgb,${brand} 10%,transparent);border-color:color-mix(in srgb,${brand} 26%,transparent)}
.dsh-agent-tabs strong{min-width:0;font-weight:500;overflow-wrap:anywhere}
.dsh-agent-tabs span{flex-shrink:0;font-size:11px;color:${secondary}}
.dsh-agent-header{padding:14px 16px;border:1px solid ${border};border-radius:var(--cp-radius);background:color-mix(in srgb,currentColor 2.5%,transparent)}
.dsh-agent-header .dsh-channel-heading{margin:0 0 8px}
.dsh-agent-header .dsh-channel-muted{margin:4px 0 0}

/* ---------- channel tabs ---------- */
.dsh-channel-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0}
.dsh-channel-tabs button{border-color:transparent;color:${secondary};padding:6px 12px;border-radius:999px;min-height:30px;font-size:12px}
.dsh-channel-tabs button:hover:not(:disabled){background:color-mix(in srgb,currentColor 6%,transparent);border-color:transparent;color:inherit}
.dsh-channel-tabs button[aria-pressed=true]{background:color-mix(in srgb,${brand} 10%,transparent);border-color:color-mix(in srgb,${brand} 28%,transparent);color:inherit;font-weight:500}

/* ---------- status ---------- */
.dsh-channel-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:500;padding:3px 9px;border-radius:999px;border:1px solid ${border};background:transparent;color:${secondary};white-space:nowrap;vertical-align:middle}
.dsh-channel-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.4;flex:none}
.dsh-channel-status.is-ok::before{background:#22a06b;opacity:1}
.dsh-channel-status.is-warn::before{background:#d29922;opacity:1}
.dsh-channel-status.is-error::before{background:${danger};opacity:1}
.dsh-channel-status.is-idle::before{background:currentColor;opacity:.35}

/* ---------- feedback ---------- */
.dsh-channel-notice{padding:10px 12px;border-radius:8px;border:1px solid ${border};background:color-mix(in srgb,currentColor 3%,transparent);font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-channel-notice p{margin:6px 0}
.dsh-channel-notice.dsh-channel-error{border-color:color-mix(in srgb,${danger} 32%,transparent);background:color-mix(in srgb,${danger} 8%,transparent);color:${danger}}

/* ---------- dialog ---------- */
.dsh-channel-modal{position:fixed;inset:0;z-index:1000;background:color-mix(in srgb,#000 45%,transparent);display:flex;align-items:center;justify-content:center;padding:16px}
.dsh-channel-modal>div{background:${surface};border:1px solid ${border};border-radius:12px;box-shadow:0 16px 48px rgb(0 0 0 / 28%);padding:20px;max-width:560px;width:100%;max-height:88vh;overflow:auto}
.dsh-channel-modal ul{padding-left:20px;overflow-wrap:anywhere}
.dsh-channel-modal .dsh-channel-actions{justify-content:flex-end;margin-top:14px}

@media(max-width:600px){.dsh-agent-layout{grid-template-columns:1fr;gap:12px}.dsh-agent-tabs{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid ${border};padding:0 0 10px}.dsh-agent-tabs button{width:auto;min-width:130px}.dsh-channel-grid{grid-template-columns:1fr}.dsh-channel-card{padding:13px}.dsh-channel-path{flex-wrap:wrap}}
`
