/** Wrangler imports `.jpg` files as Data modules in the harness Worker. */
declare module "*.jpg" {
  const data: ArrayBuffer;
  export default data;
}
