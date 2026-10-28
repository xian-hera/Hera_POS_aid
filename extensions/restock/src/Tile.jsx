import "@shopify/ui-extensions/preact";
import { render } from 'preact';

export default async () => {
  render(<Extension />, document.body);
}

// While we test, the small text shows the build number, to see at a glance whether this iPad has the
// latest version. Put back "Log in Customer first" when testing is finished.
const DEBUG_VERSION = 'debug 3';

function Extension() {
  return (
    <s-tile
      heading="Restock Notify"
      subheading={DEBUG_VERSION}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
