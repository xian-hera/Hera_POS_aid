import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/MenuItem.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.cart.line-item-details.action.menu-item.render').Api;
  const globalThis: { shopify: typeof shopify };
}
