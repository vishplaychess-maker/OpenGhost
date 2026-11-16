(() => {
'use strict';

// The sidebar's Trading Chart button, in the row Settings and Usage stand in: four candles on a chart, the tallest
// lifting a little under the pointer as a chart finding its last bar.
const LIFT = 7;

class ChartButton extends IconButton {
 constructor() {
  super(`
   <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="30 30 60 60" fill="none" aria-hidden="true">
    <g class="glyph">
     <path class="rule" d="M37 79h46" stroke="currentColor" stroke-linecap="round" opacity=".45"/>
     <path d="M43 68v-9" stroke="currentColor" stroke-linecap="round"/>
     <rect x="39.5" y="51" width="7" height="9" rx="1.6" stroke="currentColor"/>
     <path d="M56 72v-8" stroke="currentColor" stroke-linecap="round"/>
     <rect x="52.5" y="55" width="7" height="10" rx="1.6" stroke="currentColor"/>
     <path d="M69 66v-8" stroke="currentColor" stroke-linecap="round"/>
     <rect class="tall" x="65.5" y="38" width="7" height="20" rx="1.6" stroke="currentColor"/>
     <path class="stem" d="M69 38v-3" stroke="currentColor" stroke-linecap="round"/>
    </g>
   </svg>`, { press: [230, 27], lift: [120, 12] }, `
   .rule{stroke-width:4}
   rect{stroke-width:4}
   path:not(.rule){stroke-width:4}
   .tall,.stem{transform-box:fill-box;transform-origin:center}
   :host([active]) button{color:rgb(var(--icon-hover-rgb,var(--icon-rgb,255,255,255)))}`);
  this.tall = this.shadowRoot.querySelector('.tall');
  this.stem = this.shadowRoot.querySelector('.stem');
 }
 defaultLabel(){ return I18n.t('chart.title'); }
 activate(e){ this.dispatchEvent(new CustomEvent('chart-open', { bubbles: true, composed: true, detail: { keyboard: e.detail === 0 } })); }
 targets(hover, reduced){ return { lift: reduced ? 0 : hover }; }
 render(v){ this.tall.setAttribute('transform', `translate(0 ${(-(v.lift || 0) * LIFT).toFixed(2)})`); this.stem.setAttribute('transform', `translate(0 ${(-(v.lift || 0) * LIFT).toFixed(2)})`); }
}
if (!customElements.get('chart-button')) customElements.define('chart-button', ChartButton);
})();
