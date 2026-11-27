import "@shopify/ui-extensions/preact";
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { fetchNote, cartCustomerId } from './note.js';

// Apple Card Login tile, also the customer note alert.
// Normally: "Apple Card Login". When the customer in the cart has a Shopify customer note, the tile
// turns to the accent colour with "⚠ Note attention ⚠" and a toast appears once; tapping it opens the
// note first (the modal has a button to go on scanning). The note text is never shown on the tile.

export default async () => {
  render(<Extension />, document.body);
}

const RECHECK_MS = 60 * 1000; // same customer still in the cart: check again at most once a minute

function Extension() {
  const [hasNote, setHasNote] = useState(false);
  const current = useRef({ id: null, at: 0 });

  useEffect(() => {
    let alive = true;

    async function check(id, announce) {
      current.current = { id, at: Date.now() };
      if (!id) return setHasNote(false);
      if (announce) setHasNote(false);
      try {
        const data = await fetchNote(id);
        if (!alive || current.current.id !== id) return;
        setHasNote(Boolean(data?.hasNote));
        if (data?.hasNote && announce) shopify.toast.show('⚠ This customer has a note. Tap "Note attention" to read it.');
      } catch {
        // Could not check (network): keep the normal Login tile
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

  return (
    <s-tile
      heading={hasNote ? '⚠ Note attention ⚠' : 'Apple Card Login'}
      subheading={hasNote ? 'Tap to read the note for this customer' : 'Scan Apple Wallet card'}
      tone={hasNote ? 'accent' : 'auto'}
      itemCount={hasNote ? 1 : undefined}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
