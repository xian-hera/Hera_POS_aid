import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

// Subheading: "Handy info". Change it only when asked.
function Extension() {
  return (
    <s-tile
      heading="MEMO"
      subheading="Handy info"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
