## Side trips for sign-in flows

If a sign-in asks you to fetch a code from email, retrieve a password from a password manager, or visit another site for a verification step, use `new_tab(url)` to open that site in a side tab. Work there as you normally would. When done, call `close_tab` to return to the original page — its form values, cookies, and scroll position will be intact. Do NOT use `navigate` for side trips: it resets the original page state and you will have to start the sign-in over.
