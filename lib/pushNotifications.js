const { Expo } = require('expo-server-sdk');
const { sql } = require('../db');

// Create a new Expo SDK client
// optionally providing an access token if you have enabled push security
const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

/**
 * Send a push notification to a user
 * @param {string} userId - The user ID to send the notification to
 * @param {string} title - The notification title
 * @param {string} body - The notification body
 * @param {object} data - Optional data payload
 */
async function sendPushNotification(userId, title, body, data = {}) {
    try {
        // Get the user's push token
        const user = await sql`
            SELECT push_token FROM user_profiles WHERE id = ${userId}
        `;

        if (!user || user.length === 0 || !user[0].push_token) {
            console.log(`[Push] User ${userId} has no push token`);
            return;
        }

        const pushToken = user[0].push_token;

        // Check that all your push tokens appear to be valid Expo push tokens
        if (!Expo.isExpoPushToken(pushToken)) {
            console.error(`[Push] Push token ${pushToken} is not a valid Expo push token`);
            return;
        }

        // Construct the message
        const messages = [{
            to: pushToken,
            sound: 'default',
            title: title || 'GlowMatch Seller',
            body: body,
            data: data,
            _displayInForeground: true,
        }];

        // The Expo push notification service accepts batches of notifications so
        // that you don't need to send 1000 requests to send 1000 notifications.
        // We recommend you batch your notifications to reduce the number of
        // requests and to compress them (notifications with similar content will
        // get compressed).
        const chunks = expo.chunkPushNotifications(messages);
        const tickets = [];

        for (let chunk of chunks) {
            try {
                const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                console.log('[Push] Notification sent:', ticketChunk);
                tickets.push(...ticketChunk);
            } catch (error) {
                console.error('[Push] Error sending chunk:', error);
            }
        }

        // Save notification to database for history
        await sql`
            INSERT INTO notifications (title, body, sender_id, target_all, created_at)
            VALUES (${title}, ${body}, NULL, 0, NOW())
            RETURNING id
        `;

        // Note: We should ideally link this notification to the user_notifications table
        // but for now we just log it to the main notifications table.
        // Integrating fully would require 2 steps: create notification -> create user_notification link

    } catch (error) {
        console.error('[Push] Fatal error sending notification:', error);
    }
}

/**
 * Send push notification to multiple users
 */
async function sendBroadcastNotification(title, body, data = {}) {
    // Implementation for broadcast functionality
    // ...
}

module.exports = {
    sendPushNotification,
    sendBroadcastNotification
};
