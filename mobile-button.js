(() => {
'use strict';

// The sidebar's Phone button, at the far end of the row Settings and Usage stand in: a phone with two arcs of signal
// over its shoulder. Under the pointer the arcs light one after the other, as a call going out; while a phone can reach
// the app they stay lit, and while one is connected a small mark stands at the corner.
const LIVE = 'live';

class MobileButton extends IconButton {
 static get observedAttributes(){return [...super.observedAttributes,'active','connected']}
 constructor(){
  super(`
   <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="30 30 60 60" fill="none" stroke="currentColor" aria-hidden="true">
    <g class="glyph">
     <path class="phone" d="M48 42h20a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H48a5 5 0 0 1-5-5V47a5 5 0 0 1 5-5Z" stroke-linecap="round" stroke-linejoin="round"/>
     <path class="bar" d="M56 78h10" stroke-linecap="round"/>
     <path class="wave wave-a" d="M78.8 43.2A8 8 0 0 0 72.8 37.2" stroke-linecap="round"/>
     <path class="wave wave-b" d="M84.6 41.9A14 14 0 0 0 74.2 31.4" stroke-linecap="round"/>
     <circle class="${LIVE}" cx="81" cy="81" r="5.5" fill="currentColor" stroke="none"/>
    </g>
   </svg>`,{waveA:[190,20],waveB:[120,17]},`
   .phone,.bar{stroke-width:var(--icon-stroke,6)}
   .wave{stroke-width:var(--icon-stroke,6);opacity:0}
   .${LIVE}{opacity:0;transition:opacity .2s ease}
   :host([connected]) .${LIVE}{opacity:1}
   :host([active]) button{color:rgb(var(--icon-hover-rgb,var(--icon-rgb,255,255,255)))}`);
  this.waves=[this.shadowRoot.querySelector('.wave-a'),this.shadowRoot.querySelector('.wave-b')];
 }
 defaultLabel(){return I18n.t('mobile.button')}
 activate(e){this.dispatchEvent(new CustomEvent('mobile-open',{bubbles:true,composed:true,detail:{keyboard:e.detail===0}}))}
 targets(hover,reduced){
  // Listening keeps the near arc alight; a phone connected keeps both, so the call is plainly answered.
  const on=this.hasAttribute('active')?1:0, live=this.hasAttribute('connected')?1:0;
  return {waveA:reduced?on:Math.max(hover,on),waveB:reduced?live:Math.max(hover,live)};
 }
 render(v){
  this.waves[0].style.opacity=String(v.waveA*.9);
  this.waves[1].style.opacity=String(v.waveB*.6);
 }
}
if(!customElements.get('mobile-button'))customElements.define('mobile-button',MobileButton);
})();
