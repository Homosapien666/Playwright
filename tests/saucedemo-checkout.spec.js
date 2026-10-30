const { test, expect } = require('@playwright/test');

// เก็บยอดเงินเป็นจำนวนเต็มหน่วยเซนต์ เช่น $29.99 -> 2999
function moneyToCents(text) {
  const match = String(text).match(/\$\s*([\d,]+)\.(\d{2})(?!\d)/);
  expect(match, `ข้อความต้องมีราคาเป็นทศนิยม 2 ตำแหน่ง: ${text}`).not.toBeNull();
  return Number(match[1].replaceAll(',', '')) * 100 + Number(match[2]);
}

async function readProducts(rows) {
  // อ่านชื่อกับราคาใน DOM ครั้งเดียวเพื่อให้ได้ snapshot ชุดเดียวกัน
  const rawProducts = await rows.evaluateAll((elements) => elements.map((row) => ({
    name: row.querySelector('.inventory_item_name')?.textContent.trim() ?? '',
    priceText: row.querySelector('.inventory_item_price')?.textContent.trim() ?? ''
  })));

  return rawProducts.map(({ name, priceText }) => ({
    name,
    priceCents: moneyToCents(priceText)
  }));
}

function sortByName(products) {
  return [...products].sort((a, b) => a.name.localeCompare(b.name));
}

async function verifySelectedProducts(page, expectedProducts) {
  const rows = page.locator('.cart_item');
  await expect(rows, 'ต้องมีสินค้า 2 รายการ').toHaveCount(2);
  await expect.poll(
    async () => sortByName(await readProducts(rows)),
    { message: 'ชื่อและราคาต้องตรงกับสินค้าที่เลือกจากหน้า Inventory' }
  ).toEqual(sortByName(expectedProducts));
  await expect(rows.locator('.cart_quantity'), 'จำนวนต่อรายการต้องเป็น 1')
    .toHaveText(['1', '1']);
}

async function readMoney(locator) {
  await expect(locator).toBeVisible();
  return moneyToCents(await locator.innerText());
}

test('ซื้อสินค้าที่แพงที่สุดและถูกที่สุด พร้อมตรวจภาษี 8% และยอดรวม', async ({ page }) => {
  let selectedProducts;

  await test.step('1. Login ด้วย standard_user', async () => {
    await page.goto('/');
    await page.getByTestId('username').fill('standard_user');
    await page.getByTestId('password').fill('secret_sauce');
    await page.getByTestId('login-button').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');
  });

  await test.step('2. เรียงราคาจากมากไปน้อยและตรวจราคาทุกคู่ที่ติดกัน', async () => {
    const sort = page.getByTestId('product-sort-container');
    await sort.selectOption({ label: 'Price (high to low)' });
    await expect(sort).toHaveValue('hilo');

    const rows = page.locator('.inventory_item');
    await expect(rows.first()).toBeVisible();

    await expect.poll(async () => {
      const products = await readProducts(rows);
      return products.length >= 2 && products.every((product, index) => (
        index === 0 || products[index - 1].priceCents >= product.priceCents
      ));
    }, { message: 'ราคาสินค้าทุกคู่ต้องเรียงจากมากไปน้อย' }).toBe(true);

    const products = await readProducts(rows);
    expect(products.length, 'ต้องมีสินค้าอย่างน้อย 2 รายการ').toBeGreaterThanOrEqual(2);
    // ชื่อและราคาสินค้ามาจากหน้าเว็บจริง ไม่กำหนดไว้ล่วงหน้า
    selectedProducts = [products[0], products[products.length - 1]];
  });

  await test.step('3. เพิ่มสินค้าที่แพงที่สุดและถูกที่สุด ตรวจ Badge เป็น 2', async () => {
    const rows = page.locator('.inventory_item');
    await rows.first().getByRole('button', { name: 'Add to cart', exact: true }).click();
    await expect(rows.first().getByRole('button', { name: 'Remove', exact: true }))
      .toBeVisible();
    await rows.last().getByRole('button', { name: 'Add to cart', exact: true }).click();
    await expect(rows.last().getByRole('button', { name: 'Remove', exact: true }))
      .toBeVisible();
    await expect(page.locator('.shopping_cart_badge')).toHaveText('2');
  });

  await test.step('4. เปิด Cart และตรวจชื่อ ราคา และจำนวนสินค้า', async () => {
    await page.locator('.shopping_cart_link').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
    await verifySelectedProducts(page, selectedProducts);
  });

  await test.step('5. กรอกข้อมูลผู้ซื้อและไปหน้า Overview', async () => {
    await page.getByTestId('checkout').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/checkout-step-one.html');
    await page.getByTestId('firstName').fill('Somchai');
    await page.getByTestId('lastName').fill('Testing');
    await page.getByTestId('postalCode').fill('10110');
    await page.getByTestId('continue').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/checkout-step-two.html');
  });

  await test.step('6. คำนวณ Item Total, Tax 8% และ Total จากราคาใน Overview', async () => {
    await verifySelectedProducts(page, selectedProducts);
    // ดึงราคาสินค้าจากหน้า Overview มารวมใหม่ตามโจทย์
    const overviewProducts = await readProducts(page.locator('.cart_item'));
    const itemSumCents = overviewProducts.reduce((sum, product) => sum + product.priceCents, 0);
    const expectedTaxCents = Math.round((itemSumCents * 8) / 100);
    const expectedTotalCents = itemSumCents + expectedTaxCents;

    const itemTotalCents = await readMoney(page.locator('.summary_subtotal_label'));
    const taxCents = await readMoney(page.locator('.summary_tax_label'));
    const totalCents = await readMoney(page.locator('.summary_total_label'));

    expect(itemTotalCents, 'Item Total ต้องเท่ากับผลรวมราคาสินค้าใน Overview')
      .toBe(itemSumCents);
    expect(taxCents, 'Tax ต้องเท่ากับ Item Total × 8% ปัดทศนิยม 2 ตำแหน่ง')
      .toBe(expectedTaxCents);
    expect(totalCents, 'Total ต้องตรงกับผลรวมสินค้าและภาษีที่คำนวณได้')
      .toBe(expectedTotalCents);
    expect(totalCents, 'Total ต้องเท่ากับ Item Total + Tax ที่แสดงบนเว็บ')
      .toBe(itemTotalCents + taxCents);

    console.log({
      items: overviewProducts.map((product) => product.name),
      itemTotal: (itemTotalCents / 100).toFixed(2),
      tax: (taxCents / 100).toFixed(2),
      total: (totalCents / 100).toFixed(2)
    });
  });

  await test.step('7. Finish และตรวจ URL กับข้อความสำเร็จ', async () => {
    await page.getByTestId('finish').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/checkout-complete.html');
    await expect(page.getByTestId('complete-header')).toBeVisible();
    await expect(page.getByTestId('complete-header')).toHaveText('Thank you for your order!');
  });
});
