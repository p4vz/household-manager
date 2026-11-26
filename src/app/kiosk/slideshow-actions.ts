"use server";

import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { slideshowPhoto, slideshowPhotoIds } from "@/modules/family/api";

/**
 * The sleep slideshow on the kitchen screen: read-only. Choosing the photos
 * happens in Settings (members only); the screen can only show them.
 */
export const slideshowIdsAction = kioskAction("hub.view", z.object({}), async () => slideshowPhotoIds());

export const slideshowPhotoAction = kioskAction("hub.view", z.object({ id: z.uuid() }), async ({ id }) => slideshowPhoto(id));
