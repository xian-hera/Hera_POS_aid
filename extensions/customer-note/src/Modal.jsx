import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { fetchNote, cartCustomerId } from "./note.js";

// Shows the full Shopify customer note of the customer in the cart (read fresh when opened).

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [state, setState] = useState({ kind: "loading" });

  useEffect(() => {
    const id = cartCustomerId();
    if (!id) return setState({ kind: "nocustomer" });
    fetchNote(id)
      .then((data) => setState({ kind: "ok", name: data?.name || "", note: data?.hasNote ? String(data.note || "") : "" }))
      .catch((err) => setState({ kind: "error", message: err?.message || "Network error" }));
  }, []);

  let body;
  if (state.kind === "loading") body = <s-text color="subdued">Loading…</s-text>;
  else if (state.kind === "nocustomer") body = <s-text>No customer in the cart.</s-text>;
  else if (state.kind === "error") body = <s-banner tone="critical" heading="Could not read the note">{state.message}</s-banner>;
  else if (!state.note) body = <s-text>{state.name ? `${state.name} has no note.` : "This customer has no note."}</s-text>;
  else body = (
    <s-stack direction="block" gap="base">
      {state.name && <s-text type="strong">{state.name}</s-text>}
      <s-box padding="base">
        <s-stack direction="block" gap="small-200">
          {state.note.split(/\r?\n/).map((line, i) => <s-text key={i}>{line || " "}</s-text>)}
        </s-stack>
      </s-box>
      <s-text type="small" color="subdued">To change this note, edit the customer in POS or in the Shopify admin.</s-text>
    </s-stack>
  );

  return (
    <s-page key={state.kind} heading="Customer note">
      <s-scroll-box>
        <s-box padding="base">{body}</s-box>
      </s-scroll-box>
    </s-page>
  );
}
