# ZYVEN end-to-end test results

70 passed, 0 failed

## Server (accounts, privacy, realtime, storage)

- ✅ sign up a_vgvnsz
- ✅ sign up b_vgvnsz
- ✅ sign up c_vgvnsz
- ✅ each account has a unique id
- ✅ profile row created at sign-up
- ✅ duplicate email rejected
- ✅ duplicate username rejected
- ✅ username_available sees taken name
- ✅ wrong password rejected
- ✅ search finds a real registered user
- ✅ search never returns yourself
- ✅ search with no match returns nothing (no invented people)
- ✅ signed-out visitors cannot search
- ✅ add contact
- ✅ duplicate contact rejected
- ✅ cannot add yourself
- ✅ contacts are private
- ✅ direct chat created
- ✅ no duplicate direct chats (either side)
- ✅ cannot open a chat with yourself
- ✅ A sends a message
- ✅ B receives it in real time
- ✅ outsider C gets no realtime event for it
- ✅ B can load the message history
- ✅ outsider C cannot read it
- ✅ outsider C cannot post into it
- ✅ cannot send as another person
- ✅ outsider C cannot see the members
- ✅ A sees B’s read receipt
- ✅ B reacts
- ✅ B cannot edit A’s message
- ✅ B cannot delete A’s message
- ✅ A edits own message
- ✅ A uploads a file into the chat
- ✅ B can download it
- ✅ outsider C cannot download it
- ✅ outsider C cannot upload into the chat
- ✅ members get signed links
- ✅ delete for everyone clears the text for B too
- ✅ B blocks A
- ✅ blocked: A can no longer message B
- ✅ after unblock A can message again
- ✅ create group
- ✅ non-admin cannot add members
- ✅ admin adds C
- ✅ C now sees the group
- ✅ C still cannot see the A–B chat
- ✅ password reset email requested
- ✅ reset email contains a code
- ✅ reset code accepted
- ✅ new password saved
- ✅ sign in with new password
- ✅ old password no longer works
- ✅ sign out

## App in two browsers

- ✅ X creates an account in the app
- ✅ Y creates an account in the app
- ✅ new account starts with no chats and no fake people
- ✅ search with no match shows an empty state
- ✅ X adds Y as a contact
- ✅ X sends a message (confirmed by the server)
- ✅ Y sees the new chat appear without reloading
- ✅ Y opens it and reads the message
- ✅ X receives Y’s reply live
- ✅ X sees the read receipt
- ✅ photo uploads and arrives for Y
- ✅ Y sees the group X created
- ✅ Y signs out
- ✅ wrong password shows a clear error
- ✅ after signing in again, chats load from the server
- ✅ no JavaScript errors in the app
