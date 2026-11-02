import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { UnitCheck } from './UnitCheck.jsx';

// Order status page (customer account, link in the confirmation email): a second chance to answer.
export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const o = shopify.order.value;
  return <UnitCheck orderId={o?.id} number={o?.confirmationNumber} />;
}
