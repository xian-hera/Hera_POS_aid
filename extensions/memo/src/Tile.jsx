import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

// Subheading "debug 1" while testing; final text: "Quick lookup of important info".
function Extension() {
  return (
    <s-tile
      heading="MEMO"
      subheading="debug 4"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
