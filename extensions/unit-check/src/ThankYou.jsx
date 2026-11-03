import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { UnitCheck } from './UnitCheck.jsx';

// Thank you page (right after checkout). The shipping address and email are passed so the block can
// ask the server at once, without waiting for the order to be created.
export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const c = shopify.orderConfirmation.value;
  const a = shopify.shippingAddress?.value;
  const email = shopify.buyerIdentity?.email?.value;
  const address = a && {
    address1: a.address1 || '',
    address2: a.address2 || '',
    city: a.city || '',
    zip: a.zip || '',
    provinceCode: a.provinceCode || '',
    countryCode: a.countryCode || '',
  };
  return <UnitCheck orderId={c?.order?.id} number={c?.number} address={address} email={email} />;
}
