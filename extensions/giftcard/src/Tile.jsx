import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  return (
    <s-tile
      heading="Gift Card Sale"
      subheading="Sell a card / check balance"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
