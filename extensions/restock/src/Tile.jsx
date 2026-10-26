import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  return (
    <s-tile
      heading="Restock Notify"
      subheading="Notify a customer when back in stock"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
