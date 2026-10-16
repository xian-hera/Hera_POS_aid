import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  return (
    <s-tile
      heading="Apple Card Login"
      subheading="Scan Apple Wallet card"
      onClick={() => shopify.action.presentModal()}
    />
  );
}