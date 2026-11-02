import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { UnitCheck } from './UnitCheck.jsx';

// Thank you page (right after checkout).
export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const c = shopify.orderConfirmation.value;
  return <UnitCheck orderId={c?.order?.id} number={c?.number} />;
}
