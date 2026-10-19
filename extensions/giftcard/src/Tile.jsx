import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  return (
    <s-tile
      heading="Sell Gift Card"
      subheading="Scan to sell or check balance"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
