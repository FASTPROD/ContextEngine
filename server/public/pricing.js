// ---------------------------------------------------------------------------
// ContextEngine Pricing Page — Billing Toggle + Stripe Checkout
// ---------------------------------------------------------------------------
const API_BASE = 'https://api.compr.ch';
let billingPeriod = 'monthly';

const toggle = document.getElementById('billingToggle');
const labels = document.querySelectorAll('.toggle-label');

toggle.addEventListener('click', () => {
  billingPeriod = billingPeriod === 'monthly' ? 'annual' : 'monthly';
  toggle.classList.toggle('active', billingPeriod === 'annual');
  labels.forEach(l => l.classList.toggle('active', l.dataset.period === billingPeriod));
  updatePrices();
});

function updatePrices() {
  document.querySelectorAll('.plan').forEach(plan => {
    const priceEl = plan.querySelector('.plan-price');
    const annualEl = plan.querySelector('.plan-annual');
    const periodEl = plan.querySelector('.price-period');

    const price = priceEl.dataset[billingPeriod];
    const subtext = annualEl.dataset[billingPeriod];

    priceEl.childNodes[0].textContent = price;
    if (periodEl) periodEl.textContent = billingPeriod === 'monthly' ? '/mo' : '/yr';
    annualEl.textContent = subtext;
  });
}

// ---------------------------------------------------------------------------
// Stripe Checkout
// ---------------------------------------------------------------------------
async function checkout(btn) {
  const planKeyAttr = billingPeriod === 'monthly' ? 'planKeyMonthly' : 'planKeyAnnual';
  const planKey = btn.dataset[planKeyAttr];

  if (!planKey) {
    alert('Invalid plan selection');
    return;
  }

  // Loading state
  const originalText = btn.textContent;
  btn.textContent = 'Redirecting…';
  btn.classList.add('loading');

  try {
    const resp = await fetch(`${API_BASE}/contextengine/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planKey,
        successUrl: `${API_BASE}/contextengine/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${API_BASE}/contextengine/pricing`,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || 'Checkout failed');
    }

    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error('No checkout URL returned');
    }
  } catch (err) {
    console.error('Checkout error:', err);
    alert(err.message || 'Something went wrong. Please try again.');
    btn.textContent = originalText;
    btn.classList.remove('loading');
  }
}

// Attach checkout to buttons (replaces inline onclick)
document.querySelectorAll('.plan-cta[data-plan-key-monthly]').forEach(btn => {
  btn.addEventListener('click', () => checkout(btn));
});
