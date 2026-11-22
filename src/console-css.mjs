export const consoleCss = `:root{--bg:#fff;--side:#F6F8FA;--line:#E3E8EE;--line-strong:#C9D1DB;--ink:#0F1A2B;--muted:#58647A;--accent:#2457D6;--accent-dark:#1B45B0;--tint:#EAF0FD;--hover:#F1F4F8;--bad:#B42318;--bad-bg:#FDECEA;--warn:#8A4B00;--warn-bg:#FEF3E0;--ok:#1A6B3F;--ok-bg:#E6F4EC;--info-bg:#EAF0FD;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;caret-color:var(--accent);-webkit-font-smoothing:antialiased}
::selection{background:#CFDCF8;color:var(--ink)}
h1,h2,h3,p,ul,dl,dd{margin:0}
ul{padding:0;list-style:none}
a{color:var(--accent);text-decoration:none;text-underline-offset:3px}
a:hover{text-decoration:underline}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--hover);padding:.1em .35em;border-radius:4px}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.small{font-size:.8125rem}
.nowrap{white-space:nowrap}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

.app{display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:100vh}
.side{background:var(--side);border-right:1px solid var(--line);padding:1rem .75rem;display:flex;flex-direction:column;gap:1.25rem;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:.6rem;padding:.25rem .5rem;font-weight:650;font-size:1.0625rem;letter-spacing:-.01em;color:var(--ink)}
.brand:hover{text-decoration:none}
.brand-mark{width:1.5rem;height:1.5rem;border-radius:6px;background:var(--accent);color:#fff;display:grid;place-items:center}
.brand-mark svg{width:1rem;height:1rem}
.nav{display:grid;gap:2px}
.nav a{display:flex;align-items:center;gap:.65rem;padding:.45rem .5rem;border-radius:6px;color:#2A364A;font-weight:500}
.nav a:hover{background:var(--hover);text-decoration:none}
.nav a[aria-current=page]{background:var(--tint);color:var(--accent-dark)}
.nav svg{width:1.125rem;height:1.125rem;flex:none}
.nav .count{margin-left:auto;min-width:1.4rem;text-align:center;font-size:.75rem;font-weight:600;background:#E3E8EE;color:#2A364A;border-radius:999px;padding:0 .4rem;line-height:1.35rem}
.nav a[aria-current=page] .count{background:#CFDCF8;color:var(--accent-dark)}
.nav .count.alert{background:var(--accent);color:#fff}
.side-foot{margin-top:auto;display:grid;gap:.6rem;padding:0 .25rem}
.env{font-size:.75rem;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:6px;padding:.35rem .5rem}
.side-foot form{margin:0}

.content{min-width:0;padding:1.5rem 2rem 4rem;max-width:84rem;width:100%}
.crumbs{font-size:.8125rem;color:var(--muted);margin-bottom:.35rem}
.crumbs a{color:var(--muted)}
.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1.5rem;margin-bottom:1.25rem}
h1{font-size:1.5rem;line-height:1.25;font-weight:650;letter-spacing:-.015em}
.sub{color:var(--muted);margin-top:.25rem;max-width:62ch}
.banner{display:flex;gap:.6rem;align-items:flex-start;border:1px solid var(--line-strong);border-radius:8px;padding:.65rem .9rem;margin-bottom:1.25rem;background:var(--hover)}
.banner.bad{border-color:#E7A9A3;background:var(--bad-bg);color:var(--bad)}
.banner.ok{border-color:#A9D3BA;background:var(--ok-bg);color:var(--ok)}

.grid{display:grid;grid-template-columns:minmax(0,1fr) 22rem;gap:1.25rem;align-items:start}
.panel{border:1px solid var(--line);border-radius:10px;background:#fff;min-width:0}
.panel>header{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.8rem 1rem;border-bottom:1px solid var(--line)}
.panel h2{font-size:.9375rem;font-weight:650}
.panel-foot{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.7rem 1rem;border-top:1px solid var(--line);font-size:.875rem}
.stack-gap{display:grid;gap:1.25rem}

.queue li{display:grid;grid-template-columns:5.5rem minmax(0,1fr) auto;gap:1rem;align-items:center;padding:.9rem 1rem;border-bottom:1px solid var(--line)}
.queue li:last-child{border-bottom:0}
.queue strong{font-weight:600;display:block;overflow-wrap:anywhere}
.queue .muted{display:block;font-size:.875rem;overflow-wrap:anywhere}
.feed li{padding:.65rem 1rem;border-bottom:1px solid var(--line);display:grid;gap:.15rem}
.feed li:last-child{border-bottom:0}
.feed .line{display:flex;justify-content:space-between;align-items:center;gap:.75rem}
.feed .meta{font-size:.8125rem;color:var(--muted);overflow-wrap:anywhere}
.empty{padding:2rem 1.25rem;color:var(--muted);max-width:56ch}
.empty strong{display:block;color:var(--ink);font-weight:600;margin-bottom:.15rem}

button,.btn{font:inherit;font-weight:550;font-size:.875rem;min-height:2.125rem;padding:0 .8rem;border-radius:6px;border:1px solid var(--line-strong);background:#fff;color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;transition:background-color .15s ease-out,border-color .15s ease-out;text-decoration:none;white-space:nowrap}
button:hover,.btn:hover{background:var(--hover);text-decoration:none}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover,.btn.primary:hover{background:var(--accent-dark);border-color:var(--accent-dark)}
button.outline,.btn.outline{border-color:var(--accent);color:var(--accent-dark);background:#fff}
button.outline:hover,.btn.outline:hover{background:var(--tint)}
button.link{border:0;background:none;min-height:0;padding:.25rem .5rem;color:var(--muted);font-weight:500;text-align:left;justify-content:flex-start}
button.link:hover{color:var(--ink);background:var(--hover)}
button:active{background:var(--tint)}
button:disabled,.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed;pointer-events:none}
form{margin:0}
.row-actions{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:flex-end}

.pill{display:inline-flex;align-items:center;gap:.3rem;font-size:.75rem;font-weight:600;line-height:1.25rem;padding:0 .5rem;border-radius:999px;white-space:nowrap;background:var(--hover);color:#2A364A}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}
.pill.info{background:var(--info-bg);color:var(--accent-dark)}
.pill svg{width:.75rem;height:.75rem}

.tabs{display:flex;gap:.25rem;border-bottom:1px solid var(--line);margin-bottom:1rem}
.tabs a{padding:.5rem .75rem;color:var(--muted);font-weight:550;border-bottom:2px solid transparent;margin-bottom:-1px;display:flex;gap:.4rem;align-items:center}
.tabs a:hover{color:var(--ink);text-decoration:none}
.tabs a[aria-current=page]{color:var(--accent-dark);border-bottom-color:var(--accent)}
.tabs .n{font-size:.75rem;background:var(--hover);border-radius:999px;padding:0 .4rem;line-height:1.25rem;color:var(--muted)}

table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.7rem 1rem;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{font-size:.8125rem;font-weight:600;color:var(--muted);background:var(--side);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#FAFBFD}
td.r,th.r{text-align:right}
td.end{text-align:right;white-space:nowrap}
td .sub-line,.checks .sub-line,dd .sub-line{display:block;font-size:.8125rem;color:var(--muted)}
.tender{font-weight:600;font-variant-numeric:tabular-nums}
.table-wrap{overflow-x:auto}

.detail{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:1.25rem;align-items:start}
.props{padding:.25rem 1rem}
.props div{display:grid;grid-template-columns:7.5rem minmax(0,1fr);gap:.75rem;padding:.55rem 0;border-bottom:1px solid var(--line);font-size:.9rem}
.props div:last-child{border-bottom:0}
.props dt{color:var(--muted)}
.props dd{overflow-wrap:anywhere}
.prose{padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere;max-width:72ch}
.brief-prose{white-space:normal}
.brief-prose h3{font-size:.875rem;font-weight:650;margin:.9rem 0 .3rem}
.brief-prose h3:first-child{margin-top:0}
.brief-prose p{margin:0 0 .45rem}
.brief-prose ul{list-style:disc;padding-left:1.25rem;display:grid;gap:.3rem}
.note{padding:.65rem 1rem;border-top:1px solid var(--line);font-size:.8125rem;color:var(--muted);background:var(--side);border-radius:0 0 10px 10px}
.checks li{display:grid;grid-template-columns:1.25rem minmax(0,1fr);gap:.6rem;padding:.65rem 1rem;border-bottom:1px solid var(--line);font-size:.9rem}
.checks li:last-child{border-bottom:0}
.checks svg{width:1.1rem;height:1.1rem;margin-top:.1rem}
.checks .ok{color:var(--ok)}.checks .warn{color:var(--warn)}.checks .bad{color:var(--bad)}
.checks .t{font-weight:600}
.decision{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;justify-content:space-between;padding:.5rem 1rem;border:1px solid var(--line);border-radius:10px;background:#fff;margin-top:1.25rem;box-shadow:0 -2px 8px rgba(15,26,43,.06)}
.decision details.decline summary{cursor:pointer;font-weight:550;font-size:.875rem;color:var(--muted)}
.decision details.decline[open]{flex-basis:100%}

.rates{display:grid;grid-template-columns:1fr 1fr}
.rate{padding:1rem 1.25rem;display:grid;gap:.15rem;align-content:start}
.rate+.rate{border-left:1px solid var(--line)}
.rate .label{font-weight:600}
.rate .big{font-size:2.25rem;line-height:1.15;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.meter{display:block;margin-top:.6rem;overflow:visible}
.meter .track{fill:#E3E8EE}
.meter .fill{fill:var(--accent)}
.meter .tick{stroke:var(--ink);stroke-width:1.5}
.meter text{font-size:12px;fill:var(--muted)}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}

.login{max-width:26rem;margin:14vh auto;padding:0 1.5rem;display:grid;gap:1rem}
.login form{display:grid;gap:.6rem}
.login label{font-weight:600}
.login input{font:inherit;min-height:2.5rem;padding:0 .75rem;border:1px solid var(--line-strong);border-radius:6px;background:#fff;color:var(--ink)}
.login input:focus-visible{outline:2px solid var(--accent);border-color:var(--accent)}
.login .brand{padding:0}

@media (max-width:1100px){.grid,.detail{grid-template-columns:1fr}}
@media (max-width:900px){
.app{grid-template-columns:1fr}
.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.6rem .75rem;border-right:0;border-bottom:1px solid var(--line)}
.nav{display:flex;overflow-x:auto;order:3;width:100%;gap:.25rem}
.nav a{white-space:nowrap}
.side-foot{margin:0 0 0 auto;display:flex;align-items:center;gap:.5rem}
.env{display:none}
.content{padding:1rem 1rem 3rem}
.page-head{flex-direction:column;gap:.75rem}
.queue li{grid-template-columns:1fr;gap:.5rem}
.rates{grid-template-columns:1fr}.rate+.rate{border-left:0;border-top:1px solid var(--line)}
table.stack,table.stack thead,table.stack tbody,table.stack tr,table.stack th,table.stack td{display:block}
table.stack thead{position:absolute;clip:rect(0 0 0 0)}
table.stack tr{border-bottom:1px solid var(--line);padding:.5rem 0}
table.stack tbody tr:last-child{border-bottom:0}
table.stack td{border:0;padding:.3rem 1rem}
table.stack td[data-label]::before{content:attr(data-label);display:block;font-size:.75rem;color:var(--muted)}
table.stack td.end,table.stack td.r{text-align:left}
.decision{position:static;flex-direction:column;align-items:stretch}
}
@media (prefers-reduced-motion:reduce){button,.btn{transition:none}}

.chip{display:inline-block;white-space:nowrap;border:1px solid var(--line-strong);border-radius:999px;padding:.1rem .55rem;font-size:.75rem;font-weight:600;color:var(--muted);vertical-align:middle}
.chip.progress{border-color:var(--accent);color:var(--accent-dark);background:var(--info-bg)}
.chip.done{border-color:#A9D3BA;color:var(--ok);background:var(--ok-bg)}
.chip.warning{border-color:#F0C98A;color:var(--warn);background:var(--warn-bg)}
.chip.danger{border-color:#E7A9A3;color:var(--bad);background:var(--bad-bg)}
form.decline{display:grid;gap:.4rem;margin-top:.75rem;max-width:40rem}
form.decline label{font-size:.8125rem;font-weight:600}
textarea{font:inherit;padding:.5rem .6rem;border:1px solid var(--line-strong);border-radius:6px;resize:vertical}
textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.detail>.stack-gap{min-width:0}

.nav-group{margin:1rem .75rem .25rem;font-size:.6875rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.eyebrow{margin:0 0 .15rem;font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent-dark)}
form.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.6rem;margin-bottom:1rem}
form.filters label{display:grid;gap:.2rem;font-size:.8125rem;font-weight:600}
form.filters input,form.filters select{font:inherit;padding:.4rem .5rem;border:1px solid var(--line-strong);border-radius:6px;background:#fff;min-width:9rem}
dd form{display:inline}
.form-grid{display:grid;gap:.6rem;padding:1rem}
.form-grid label{display:grid;gap:.25rem;font-size:.8125rem;font-weight:600}
.form-grid select{font:inherit;padding:.35rem .5rem;border:1px solid var(--line-strong);border-radius:6px;background:#fff;max-width:20rem}
`;
