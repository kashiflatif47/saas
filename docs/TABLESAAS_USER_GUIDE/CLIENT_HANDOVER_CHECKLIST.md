# Client Handover Checklist

One copy per restaurant. Tick each step; record dates and initials. **Never write passwords on this sheet.**

Restaurant: ____________________  Subdomain: ____________________  Plan: __________  Date: __________

## A. Platform side (Super Admin)
- [ ] Client information collected (`RESTAURANT_CLIENT_SETUP_FORM.md`)
- [ ] Subdomain chosen and confirmed with the client (it can't be changed later)
- [ ] Restaurant created: **Restaurants → New restaurant** (plan, currency, contact)
- [ ] Owner account created in the same form (owner name and email)
- [ ] Restaurant page checked: address opens and shows the restaurant
- [ ] Restaurant details completed (time zone, language, address)
- [ ] Credentials sent securely: address and email in one message, temporary password through a **different** channel

## B. Owner first sign-in (together with the client)
- [ ] Owner signs in at `https://<subdomain>.<domain>/login`
- [ ] Owner changes the temporary password (key icon → Change password)
- [ ] **Branding**: logo, hero photo, colours, headline, about text → Publish
- [ ] **Settings → General**: phone, address
- [ ] **Settings → Ordering & tax**: opening hours, languages, order types, tax, service charge
- [ ] **Menu**: categories created
- [ ] **Menu**: dishes created with prices, options and photos
- [ ] **Tables & QR**: tables created; QR PDF printed
- [ ] **Staff & roles**: staff accounts created with the right roles
- [ ] *(Optional)* **Settings → Payments**: Stripe keys entered and **Verify with Stripe** succeeded

## C. Live test (before opening to guests)
- [ ] Scan a printed QR with a phone: the right restaurant and table open
- [ ] Place a test order from the phone
- [ ] Order appears in **Orders** with sound; staff **Accept**
- [ ] Kitchen display shows the ticket; **Start** → **Ready**
- [ ] Waiter **Mark served**; cashier **Collect payment**; **Complete & close**
- [ ] Guest tracking page shows each step
- [ ] Each staff role signs in and sees only its own screens
- [ ] Test order cancelled or completed (and refunded if paid)

## D. Handover
- [ ] Client received `CLIENT_ONBOARDING_GUIDE.md` (and `RESTAURANT_OWNER_USER_GUIDE.md`, `STAFF_USER_GUIDE.md`)
- [ ] Client knows who to contact for password resets, unlocks and renewals
- [ ] Trial end date / renewal date communicated: __________

Platform contact: ____________________  Client contact: ____________________
