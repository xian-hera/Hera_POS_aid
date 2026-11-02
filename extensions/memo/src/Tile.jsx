import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

// During tests the subheading shows "debug N"; final text: "Handy info".
function Extension() {
  return (
    <s-tile
      heading="MEMO"
      subheading="Handy info"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
