/**
 * Penalty Service Module
 * 
 * Handles the 3-strikes penalty system for sellers who violate product safety rules:
 * - Strike 1-2: Warning + product deletion
 * - Strike 3: Account lock
 * - Probation violation: Permanent ban + blacklist
 */

const { sql } = require('../db');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

/**
 * Hash email for blacklist storage
 */
function hashEmail(email) {
  if (!email) return null;
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

/**
 * Record a violation and apply appropriate penalty
 * 
 * @param {string} sellerId - Seller's user UUID
 * @param {string} productId - Product UUID (optional, may be deleted)
 * @param {string} productName - Product name for logging
 * @param {Array} detectedIngredients - List of flagged ingredients
 * @param {string} violationType - Type of violation (default: 'toxic_ingredient')
 * @returns {Promise<{success: boolean, action: string, message: string, violation: Object}>}
 */
async function applyPenalty(sellerId, productId, productName, detectedIngredients, violationType = 'toxic_ingredient') {
  try {
    // 1. Get current seller status
    const sellers = await sql`
      SELECT id, email, full_name, violation_count, account_status, is_under_probation
      FROM users 
      WHERE id = ${sellerId}
    `;

    if (!sellers || sellers.length === 0) {
      return { success: false, action: 'none', message: 'Seller not found' };
    }

    const seller = sellers[0];
    const currentViolations = seller.violation_count || 0;
    const newViolationCount = currentViolations + 1;
    const isOnProbation = seller.is_under_probation === true || seller.is_under_probation === 1;

    // 2. Log the violation
    const violationId = uuidv4();
    await sql`
      INSERT INTO seller_violations (id, seller_id, product_id, product_name, violation_type, detected_ingredients, penalty_applied)
      VALUES (
        ${violationId},
        ${sellerId},
        ${productId || null},
        ${productName || 'Unknown Product'},
        ${violationType},
        ${JSON.stringify(detectedIngredients)},
        ${newViolationCount >= 3 || isOnProbation ? (isOnProbation ? 'ban' : 'lock') : 'warning'}
      )
    `;

    // 3. Save rejected product data for AI training
    if (productId) {
      try {
        const products = await sql`SELECT * FROM seller_products WHERE id = ${productId}`;
        if (products && products.length > 0) {
          await sql`
            INSERT INTO rejected_products (seller_id, original_product_data, detected_ingredients, rejection_reason, rejection_phase)
            VALUES (
              ${sellerId},
              ${JSON.stringify(products[0])},
              ${JSON.stringify(detectedIngredients)},
              ${`Found ${detectedIngredients.length} toxic ingredient(s)`},
              ${'immediate'}
            )
          `;
        }
      } catch (e) {
        console.warn('[penaltyService] Error saving rejected product:', e.message);
      }
    }

    // 4. Apply penalty based on violation count and probation status
    let action = 'warning';
    let message = '';

    if (isOnProbation) {
      // Probation violation = Permanent ban
      action = 'ban';

      // Update user status to BANNED
      await sql`
        UPDATE users SET
          violation_count = ${newViolationCount},
          account_status = 'BANNED',
          last_violation_at = NOW()
        WHERE id = ${sellerId}
      `;

      // Add to blacklist
      await sql`
        INSERT INTO seller_blacklist (email, email_hash, ban_reason, original_user_id)
        VALUES (
          ${seller.email},
          ${hashEmail(seller.email)},
          ${'Repeated safety violations during probation'},
          ${sellerId}
        )
      `;

      message = 'Your account has been permanently banned due to repeated safety violations during probation. You may no longer sell on this platform.';

    } else if (newViolationCount >= 3) {
      // 3rd strike = Account lock
      action = 'lock';

      await sql`
        UPDATE users SET
          violation_count = ${newViolationCount},
          account_status = 'LOCKED',
          last_violation_at = NOW()
        WHERE id = ${sellerId}
      `;

      message = 'Your account has been locked due to 3 safety violations. Please contact support to appeal.';

    } else {
      // Warning (1st or 2nd strike)
      action = 'warning';

      await sql`
        UPDATE users SET
          violation_count = ${newViolationCount},
          last_violation_at = NOW()
        WHERE id = ${sellerId}
      `;

      const remaining = 3 - newViolationCount;
      message = `Your product "${productName}" was rejected due to harmful ingredients. You have ${remaining} warning(s) remaining before account lock.`;
    }

    // 5. Create notification for seller
    try {
      await createViolationNotification(sellerId, action, productName, detectedIngredients);
    } catch (e) {
      console.warn('[penaltyService] Error creating notification:', e.message);
    }

    return {
      success: true,
      action,
      message,
      violation: {
        id: violationId,
        sellerId,
        productId,
        productName,
        violationType,
        detectedIngredients,
        newViolationCount,
        penaltyApplied: action
      }
    };

  } catch (error) {
    console.error('[penaltyService] applyPenalty error:', error);
    return { success: false, action: 'error', message: error.message };
  }
}

/**
 * Create a notification for the seller about their violation
 */
async function createViolationNotification(sellerId, action, productName, detectedIngredients) {
  const ingredientList = detectedIngredients.map(i => i.name || i).join(', ');

  let title, body;

  switch (action) {
    case 'ban':
      title = '⛔ Account Permanently Banned';
      body = `Your account has been permanently banned due to repeated safety violations. Your product "${productName}" contained prohibited ingredients: ${ingredientList}. This decision is final.`;
      break;
    case 'lock':
      title = '🔒 Account Locked - 3 Strikes';
      body = `Your account has been locked due to 3 safety violations. Your product "${productName}" contained prohibited ingredients: ${ingredientList}. Contact support to submit an appeal.`;
      break;
    default:
      title = '⚠️ Product Rejected - Safety Violation';
      body = `Your product "${productName}" was rejected because it contains prohibited ingredients: ${ingredientList}. Please remove these ingredients and resubmit.`;
  }

  // Insert notification
  const notificationId = uuidv4();
  await sql`
    INSERT INTO notifications (id, title, body, target_all)
    VALUES (${notificationId}, ${title}, ${body}, 0)
  `;

  // Link to user
  await sql`
    INSERT INTO user_notifications (notification_id, user_id)
    VALUES (${notificationId}, ${sellerId})
  `;
}

/**
 * Unlock a locked seller account (admin action)
 * Sets the account to ACTIVE with probation flag
 * 
 * @param {string} sellerId - Seller's user UUID
 * @param {string} adminId - Admin's user UUID who approved
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function unlockAccount(sellerId, adminId) {
  try {
    // Get seller
    const sellers = await sql`SELECT id, account_status FROM users WHERE id = ${sellerId}`;

    if (!sellers || sellers.length === 0) {
      return { success: false, message: 'Seller not found' };
    }

    if (sellers[0].account_status === 'BANNED') {
      return { success: false, message: 'Cannot unlock a permanently banned account' };
    }

    // Unlock with probation
    await sql`
      UPDATE users SET
        account_status = 'ACTIVE',
        is_under_probation = true,
        probation_started_at = NOW()
      WHERE id = ${sellerId}
    `;

    // Notify seller
    const notificationId = uuidv4();
    await sql`
      INSERT INTO notifications (id, title, body, target_all)
      VALUES (
        ${notificationId}, 
        '✅ Account Unlocked - Probation Period',
        'Your account has been unlocked after review. You are now on probation. Any further violations will result in permanent ban.',
        0
      )
    `;

    await sql`
      INSERT INTO user_notifications (notification_id, user_id)
      VALUES (${notificationId}, ${sellerId})
    `;

    return { success: true, message: 'Account unlocked and placed on probation' };

  } catch (error) {
    console.error('[penaltyService] unlockAccount error:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Check if an email is blacklisted
 * 
 * @param {string} email - Email to check
 * @returns {Promise<{blacklisted: boolean, reason: string}>}
 */
async function isBlacklisted(email) {
  try {
    const emailHash = hashEmail(email);

    const results = await sql`
      SELECT id, ban_reason FROM seller_blacklist 
      WHERE email = ${email.toLowerCase()} OR email_hash = ${emailHash}
    `;

    if (results && results.length > 0) {
      return { blacklisted: true, reason: results[0].ban_reason };
    }

    return { blacklisted: false, reason: null };

  } catch (error) {
    console.error('[penaltyService] isBlacklisted error:', error);
    return { blacklisted: false, reason: null };
  }
}

/**
 * Get seller's violation history
 * 
 * @param {string} sellerId - Seller's user UUID
 * @returns {Promise<Array>}
 */
async function getViolationHistory(sellerId) {
  try {
    const violations = await sql`
      SELECT v.*, a.status as appeal_status, a.reviewed_at as appeal_reviewed_at
      FROM seller_violations v
      LEFT JOIN seller_appeals a ON a.violation_id = v.id
      WHERE v.seller_id = ${sellerId}
      ORDER BY v.created_at DESC
    `;

    return violations;

  } catch (error) {
    console.error('[penaltyService] getViolationHistory error:', error);
    return [];
  }
}

/**
 * Submit an appeal for a violation
 * 
 * @param {string} sellerId - Seller's user UUID
 * @param {string} violationId - Violation UUID to appeal
 * @param {string} reason - Appeal reason
 * @returns {Promise<{success: boolean, appealId: string, message: string}>}
 */
async function submitAppeal(sellerId, violationId, reason) {
  try {
    // Check if violation exists and belongs to seller
    const violations = await sql`
      SELECT v.id, v.created_at FROM seller_violations v 
      WHERE v.id = ${violationId} AND v.seller_id = ${sellerId}
    `;

    if (!violations || violations.length === 0) {
      return { success: false, message: 'Violation not found' };
    }

    const violation = violations[0];

    // 24-hour cooldown: Seller must wait 24 hours after the violation before appealing
    const violationTime = new Date(violation.created_at);
    const now = new Date();
    const hoursSinceViolation = (now - violationTime) / (1000 * 60 * 60);
    const COOLDOWN_HOURS = 24;

    if (hoursSinceViolation < COOLDOWN_HOURS) {
      const remainingHours = Math.ceil(COOLDOWN_HOURS - hoursSinceViolation);
      return {
        success: false,
        code: 'COOLDOWN_ACTIVE',
        message: `Please wait ${remainingHours} hour(s) before submitting an appeal. This cooldown period allows you to review the violation details.`,
        cooldownEndsAt: new Date(violationTime.getTime() + COOLDOWN_HOURS * 60 * 60 * 1000).toISOString()
      };
    }

    // Check if already appealed
    const existingAppeals = await sql`
      SELECT id FROM seller_appeals WHERE violation_id = ${violationId}
    `;

    if (existingAppeals && existingAppeals.length > 0) {
      return { success: false, message: 'An appeal has already been submitted for this violation' };
    }

    // Create appeal
    const appealId = uuidv4();
    await sql`
      INSERT INTO seller_appeals (id, seller_id, violation_id, reason, status)
      VALUES (${appealId}, ${sellerId}, ${violationId}, ${reason}, 'pending')
    `;

    return { success: true, appealId, message: 'Appeal submitted successfully. Our team will review it within 48 hours.' };

  } catch (error) {
    console.error('[penaltyService] submitAppeal error:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Review an appeal (admin action)
 * 
 * @param {string} appealId - Appeal UUID
 * @param {string} adminId - Admin's user UUID
 * @param {string} decision - 'approved' or 'rejected'
 * @param {string} notes - Admin notes
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function reviewAppeal(appealId, adminId, decision, notes = '') {
  try {
    // Get appeal details
    const appeals = await sql`
      SELECT a.*, v.seller_id, v.penalty_applied
      FROM seller_appeals a
      JOIN seller_violations v ON a.violation_id = v.id
      WHERE a.id = ${appealId}
    `;

    if (!appeals || appeals.length === 0) {
      return { success: false, message: 'Appeal not found' };
    }

    const appeal = appeals[0];

    // Update appeal status
    await sql`
      UPDATE seller_appeals SET
        status = ${decision},
        reviewed_by = ${adminId},
        reviewed_at = NOW(),
        admin_notes = ${notes}
      WHERE id = ${appealId}
    `;

    if (decision === 'approved') {
      // Reduce violation count
      await sql`
        UPDATE users SET
          violation_count = GREATEST(violation_count - 1, 0)
        WHERE id = ${appeal.seller_id}
      `;

      // If account was locked and this was the 3rd violation, unlock with probation
      const seller = await sql`SELECT account_status, violation_count FROM users WHERE id = ${appeal.seller_id}`;
      if (seller[0]?.account_status === 'LOCKED' && seller[0]?.violation_count < 3) {
        await unlockAccount(appeal.seller_id, adminId);
      }

      // Notify seller
      const notificationId = uuidv4();
      await sql`
        INSERT INTO notifications (id, title, body, target_all)
        VALUES (${notificationId}, '✅ Appeal Approved', 'Your appeal has been approved. The violation has been removed from your record.', 0)
      `;
      await sql`
        INSERT INTO user_notifications (notification_id, user_id)
        VALUES (${notificationId}, ${appeal.seller_id})
      `;
    } else {
      // Notify seller of rejection
      const notificationId = uuidv4();
      await sql`
        INSERT INTO notifications (id, title, body, target_all)
        VALUES (${notificationId}, '❌ Appeal Rejected', 'Your appeal has been reviewed and rejected. The violation remains on your record.', 0)
      `;
      await sql`
        INSERT INTO user_notifications (notification_id, user_id)
        VALUES (${notificationId}, ${appeal.seller_id})
      `;
    }

    return { success: true, message: `Appeal ${decision}` };

  } catch (error) {
    console.error('[penaltyService] reviewAppeal error:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Get seller's current account status
 * 
 * @param {string} sellerId - Seller's user UUID
 * @returns {Promise<{status: string, violationCount: number, isOnProbation: boolean}>}
 */
async function getAccountStatus(sellerId) {
  try {
    const sellers = await sql`
      SELECT account_status, violation_count, is_under_probation, probation_started_at, last_violation_at
      FROM users WHERE id = ${sellerId}
    `;

    if (!sellers || sellers.length === 0) {
      return null;
    }

    const seller = sellers[0];
    return {
      status: seller.account_status || 'ACTIVE',
      violationCount: seller.violation_count || 0,
      isOnProbation: seller.is_under_probation === true || seller.is_under_probation === 1,
      probationStartedAt: seller.probation_started_at,
      lastViolationAt: seller.last_violation_at
    };

  } catch (error) {
    console.error('[penaltyService] getAccountStatus error:', error);
    return null;
  }
}

module.exports = {
  applyPenalty,
  unlockAccount,
  isBlacklisted,
  getViolationHistory,
  submitAppeal,
  reviewAppeal,
  getAccountStatus,
  hashEmail
};
