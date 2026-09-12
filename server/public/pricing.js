// ---------------------------------------------------------------------------
// ContextEngine Pricing Page — Billing Toggle + Stripe Hub Checkout
//
// Checkout goes through the fleet's Stripe Hub (api.compr.ch/stripe-hub), not
// the activation server's own Stripe route. The hub requires customer_email and
// answers { url } for a live Stripe Checkout session. The licence key is mailed
// to that address once the hub calls back /contextengine/hub-callback.
// Plan: docs/STRIPE_HUB_INTEGRATION_PLAN.md (section 4 step 3).
// ---------------------------------------------------------------------------
const API_BASE = 'https://api.compr.ch';
const HUB_CHECKOUT_URL = `${API_BASE}/stripe-hub/api/checkout`;
const HUB_PROJECT_SLUG = 'contextengine';
let billingPeriod = 'monthly';

const toggle = document.getElementById('billingToggle');
const labels = document.querySelectorAll('.toggle-label');
const emailWrap = document.querySelector('.checkout-email');
const emailInput = document.getElementById('customerEmail');

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
// Email (required by the hub; same shape check as the hub's own)
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readEmail() {
  const value = (emailInput.value || '').trim();
  const ok = EMAIL_RE.test(value);
  emailWrap.classList.toggle('invalid', !ok);
  if (!ok) emailInput.focus();
  return ok ? value : null;
}

emailInput.addEventListener('input', () => {
  if (emailWrap.classList.contains('invalid') && EMAIL_RE.test(emailInput.value.trim())) {
    emailWrap.classList.remove('invalid');
  }
});

// ---------------------------------------------------------------------------
// Stripe Hub Checkout
// ---------------------------------------------------------------------------
async function checkout(btn) {
  const slugAttr = billingPeriod === 'monthly' ? 'planSlugMonthly' : 'planSlugAnnual';
  const planSlug = btn.dataset[slugAttr];

  if (!planSlug) {
    alert('Invalid plan selection');
    return;
  }

  const email = readEmail();
  if (!email) return;

  // Loading state
  const originalText = btn.textContent;
  btn.textContent = 'Redirecting…';
  btn.classList.add('loading');

  try {
    // The hub appends ?session_id={CHECKOUT_SESSION_ID} to success_url itself.
    const resp = await fetch(HUB_CHECKOUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_slug: HUB_PROJECT_SLUG,
        plan_slug: planSlug,
        customer_email: email,
        success_url: `${API_BASE}/contextengine/success`,
        cancel_url: `${API_BASE}/contextengine/pricing`,
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

document.querySelectorAll('.plan-cta[data-plan-slug-monthly]').forEach(btn => {
  btn.addEventListener('click', () => checkout(btn));
});
