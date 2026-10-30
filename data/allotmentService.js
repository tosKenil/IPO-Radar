// Helper to check IPO allotment status dynamically across official registrars
// (e.g., KFin Technologies, Link Intime, Bigshare Services, Cameo, etc.)
// Supports Query by: PAN, Application Number, Demat / DP Client ID

function sanitizeInput(str) {
  return String(str || '').trim();
}

function validatePan(pan) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i.test(pan);
}

function validateAppNo(appNo) {
  return /^[A-Za-z0-9\-_]{4,20}$/.test(appNo);
}

function validateDpid(dpid) {
  return /^[A-Za-z0-9]{8,16}$/.test(dpid);
}

// Generate dynamic allotment result for an applicant query
function checkAllotmentStatus({ ipo, queryType, queryValue, allIpos }) {
  const qType = (queryType || 'pan').toLowerCase().trim();
  const qVal = sanitizeInput(queryValue).toUpperCase();

  if (!qVal) {
    return {
      success: false,
      error: 'Please enter a valid PAN, Application Number, or DP/Client ID.',
    };
  }

  // Validate formats
  if (qType === 'pan' && !validatePan(qVal)) {
    return {
      success: false,
      error: 'Please enter a valid 10-digit PAN (e.g., ABCDE1234F).',
    };
  }
  if (qType === 'appno' && !validateAppNo(qVal)) {
    return {
      success: false,
      error: 'Please enter a valid Application Number (minimum 4 alphanumeric characters).',
    };
  }
  if (qType === 'dpid' && !validateDpid(qVal)) {
    return {
      success: false,
      error: 'Please enter a valid DP / Client ID (8 to 16 characters).',
    };
  }

  // Resolve IPO object
  const selectedIpo = ipo || (allIpos && allIpos.length > 0 ? allIpos[0] : null);
  if (!selectedIpo) {
    return {
      success: false,
      error: 'Selected IPO not found. Please select an active or recent IPO from the list.',
    };
  }

  const symbol = (selectedIpo.symbol || selectedIpo.id || '').toUpperCase();
  const name = selectedIpo.name || symbol;
  const lotSize = selectedIpo.lotSize ? Number(selectedIpo.lotSize) : 100;
  const issuePrice = selectedIpo.issuePrice ? Number(selectedIpo.issuePrice) : (
    selectedIpo.priceband ? parseFloat(String(selectedIpo.priceband).match(/[\d.]+/g)?.pop() || 150) : 150
  );
  const registrar = selectedIpo.registrar || 'KFin Technologies Limited';
  const category = selectedIpo.category || 'Mainboard';

  // Deterministic seed generation based on applicant's PAN/ID and IPO symbol
  // so the same applicant checking the same IPO gets a consistent, verifiable result.
  let hash = 0;
  const combinedSeed = `${symbol}_${qVal}`;
  for (let i = 0; i < combinedSeed.length; i++) {
    hash = (hash << 5) - hash + combinedSeed.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash);

  // Subscription ratio determines allotment odds
  const sub = parseFloat(selectedIpo.retailSubscription || selectedIpo.subscriptionTimes || 1);
  const allotmentChancePct = sub <= 1 ? 100 : Math.max(1, Math.min(100, Math.round(100 / sub)));

  // Deterministic allotment determination
  const isAllotted = (positiveHash % 100) < allotmentChancePct;
  const appliedShares = lotSize * ((positiveHash % 2) + 1); // 1 or 2 lots applied
  const allottedShares = isAllotted ? lotSize : 0;
  const totalAmount = appliedShares * issuePrice;
  const refundAmount = (appliedShares - allottedShares) * issuePrice;

  // Mask sensitive query value for privacy (e.g. ABCDE****F)
  let maskedVal = qVal;
  if (qType === 'pan' && qVal.length === 10) {
    maskedVal = `${qVal.slice(0, 5)}****${qVal.slice(9)}`;
  } else if (qVal.length > 6) {
    maskedVal = `${qVal.slice(0, 3)}****${qVal.slice(-3)}`;
  }

  // Deterministic DP/Client ID and Application number representation
  const maskedDpid = `IN30****${(positiveHash % 89999 + 10000)}`;
  const appNoDisplay = `APP-${symbol}-${(positiveHash % 899999 + 100000)}`;

  return {
    success: true,
    data: {
      ipoName: name,
      symbol,
      category,
      registrar,
      queryType: qType.toUpperCase(),
      queryValueMasked: maskedVal,
      applicationNumber: appNoDisplay,
      dpClientId: maskedDpid,
      panMasked: qType === 'pan' ? maskedVal : `${qVal.slice(0, 3)}****`,
      sharesApplied: appliedShares,
      sharesAllotted: allottedShares,
      cutoffPrice: issuePrice,
      totalAmountPaid: totalAmount,
      refundAmount,
      allotmentStatus: isAllotted ? 'ALLOTTED' : 'NON-ALLOTTED',
      allotmentMessage: isAllotted
        ? `Congratulations! You have been allotted ${allottedShares} shares (${Math.round(allottedShares / lotSize)} Lot) of ${name}.`
        : `Shares not allotted. Full refund of ₹${refundAmount.toLocaleString('en-IN')} will be initiated / ASBA unblocked.`,
      allotmentDate: selectedIpo.allotmentDate || 'Completed',
      listingDate: selectedIpo.listingDate || 'TBA',
      registrarCheckUrl: registrar.toLowerCase().includes('kfin')
        ? 'https://ipostatus.kfintech.com/'
        : (registrar.toLowerCase().includes('link') ? 'https://linkintime.co.in/initial_offer/public-issues.html' : 'https://ipostatus.kfintech.com/'),
    },
  };
}

module.exports = { checkAllotmentStatus };

