import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { fetchNote, cartCustomerId } from "./note.js";

// Customer Note tile.
// Watches the cart: when the customer in the cart has a Shopify customer note, the tile turns to the
// accent colour, shows "⚠ Customer note" with a count of 1, and a short toast appears once.
// The note text itself is shown only after tapping the tile (customers may see the iPad screen).

export default async () => {
  render(<Extension />, document.body);
};

const RECHECK_MS = 60 * 1000; // same customer still in the cart: check again at most once a minute

function Extension() {
  const [state, setState] = useState({ kind: "none" }); // none | checking | clear | note | error
  const current = useRef({ id: null, at: 0 });

  useEffect(() => {
    let alive = true;

    async function check(id, announce) {
      current.current = { id, at: Date.now() };
      if (!id) return setState({ kind: "none" });
      setState((s) => (s.kind === "note" && !announce ? s : { kind: "checking" }));
      try {
        const data = await fetchNote(id);
        if (!alive || current.current.id !== id) return;
        if (data?.hasNote) {
          setState({ kind: "note" });
          if (announce) shopify.toast.show("⚠ This customer has a note. Tap \"Customer note\".");
        } else {
          setState({ kind: "clear" });
        }
      } catch {
        if (alive && current.current.id === id) setState({ kind: "error" });
      }
    }

    function onCart() {
      const id = cartCustomerId();
      const prev = current.current;
      if (id !== prev.id) return check(id, true); // customer added, removed or changed
      if (id && Date.now() - prev.at > RECHECK_MS) check(id, false); // picks up a note added meanwhile
    }

    let unsubscribe = () => {};
    try { unsubscribe = shopify.cart.current.subscribe(onCart); } catch { /* not available */ }
    onCart();
    return () => { alive = false; unsubscribe(); };
  }, []);

  const k = state.kind;
  return (
    <s-tile
      heading={k === "note" ? "⚠ Customer note" : "Customer note"}
      subheading={
        k === "note" ? "Tap to view" :
        k === "clear" ? "None" :
        k === "checking" ? "Checking…" :
        k === "error" ? "Could not check" : "No customer"
      }
      tone={k === "note" ? "accent" : "auto"}
      itemCount={k === "note" ? 1 : undefined}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
