// The GI Tracker script (public/js/gi.js), when a page loads it. Always call it with optional chaining.
interface Window {
  gitracker?: ((cmd: 'goal' | 'identify' | 'pageview', a?: any, b?: any) => void) & {
    q?: unknown[];
    attribution?: () => { gi_visitor_id?: string; gi_session_id?: string };
    razorpayNotes?: () => { gi_visitor_id?: string; gi_session_id?: string };
  };
}
