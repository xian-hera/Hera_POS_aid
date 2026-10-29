import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  return (
    <s-tile
      heading="Restock Notify"
      subheading="Log in Customer first"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
