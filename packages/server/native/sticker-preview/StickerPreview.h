// Bounded public ImageIO conversion. No Messages or private-framework access.
#pragma once
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreVideo/CVPixelBuffer.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#include <math.h>

enum { SPMaxInputBytes = 5 * 1024 * 1024, SPMaxOutputBytes = 16 * 1024 * 1024,
       SPMaxDimension = 618, SPMaxFrames = 100, SPMaxPixels = 25000000 };

static inline BOOL SPNumber(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
        && isfinite([value doubleValue]);
}

static inline BOOL SPInteger(id value, NSUInteger maximum) {
    return SPNumber(value) && [value doubleValue] >= 0 && [value doubleValue] <= maximum
        && floor([value doubleValue]) == [value doubleValue];
}

static inline BOOL SPPath(NSString *path) {
    if (![path isKindOfClass:NSString.class] || path.length < 2 || path.length > 4096
        || ![path hasPrefix:@"/"] || [path rangeOfString:@"\0"].location != NSNotFound) return NO;
    NSArray *components = [path componentsSeparatedByString:@"/"];
    for (NSUInteger index = 1; index < components.count; index++) {
        NSString *component = components[index];
        if (!component.length || [component isEqual:@"."] || [component isEqual:@".."]) return NO;
    }
    return YES;
}

static inline int SPDirectory(NSString *path, BOOL output) {
    if (!SPPath(path)) return -1;
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    for (NSString *component in path.pathComponents) {
        if ([component isEqual:@"/"]) continue;
        int next = openat(fd, component.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd); if (next < 0) return -1; fd = next;
    }
    struct stat info;
    if (fstat(fd, &info) || !S_ISDIR(info.st_mode)
        || (output && (info.st_uid != getuid() || (info.st_mode & 0077)))) { close(fd); return -1; }
    return fd;
}

static inline NSData *SPRead(NSString *path, NSString **error) {
    if (error) *error = @"input_unavailable";
    if (!SPPath(path)) return nil;
    int parent = SPDirectory(path.stringByDeletingLastPathComponent, NO);
    if (parent < 0) return nil;
    int fd = openat(parent, path.lastPathComponent.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    close(parent); if (fd < 0) return nil;
    struct stat before, after;
    if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_uid != getuid() || before.st_size <= 0) { close(fd); return nil; }
    if (before.st_size > SPMaxInputBytes) { close(fd); if (error) *error = @"input_too_large"; return nil; }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t count = read(fd, (unsigned char *)data.mutableBytes + offset, data.length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { close(fd); return nil; } offset += (NSUInteger)count;
    }
    unsigned char extra; ssize_t remaining;
    do { remaining = read(fd, &extra, 1); } while (remaining < 0 && errno == EINTR);
    BOOL unchanged = !fstat(fd, &after) && before.st_dev == after.st_dev && before.st_ino == after.st_ino
        && before.st_size == after.st_size && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec
        && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
    close(fd);
    if (remaining != 0 || !unchanged) return nil;
    if (error) *error = nil; return [data copy];
}

static inline BOOL SPAuxiliaryAllowed(NSDictionary *properties, BOOL *requiresAlpha) {
    id auxiliary = properties[(NSString *)kCGImagePropertyAuxiliaryData];
    if (!auxiliary) return YES;
    if (![auxiliary isKindOfClass:NSArray.class] || [auxiliary count] > SPMaxFrames) return NO;
    for (id entry in auxiliary) {
        if (![entry isKindOfClass:NSDictionary.class]) return NO;
        id type = entry[(NSString *)kCGImagePropertyAuxiliaryDataType];
        if (![type isEqual:@"urn:mpeg:hevc:2015:auxid:1"]
            && ![type isEqual:@"urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"]) return NO;
        if (requiresAlpha) *requiresAlpha = YES;
    }
    return YES;
}

static inline BOOL SPContainerAuxiliaryAllowed(NSDictionary *properties, BOOL *requiresAlpha) {
    if (!SPAuxiliaryAllowed(properties, requiresAlpha)) return NO;
    id contents = properties[(NSString *)kCGImagePropertyFileContentsDictionary];
    if (!contents) return YES;
    if (![contents isKindOfClass:NSDictionary.class]) return NO;
    id images = contents[(NSString *)kCGImagePropertyImages];
    if (!images) return YES;
    if (![images isKindOfClass:NSArray.class] || [images count] > SPMaxFrames) return NO;
    for (id image in images) if (![image isKindOfClass:NSDictionary.class] || !SPAuxiliaryAllowed(image, requiresAlpha)) return NO;
    return YES;
}

// Raster-only exception. Matching monochrome metadata does not identify the
// auxiliary's semantics; decoded alpha and pixel roundtrip remain mandatory.
static inline BOOL SPStaticRasterAuxiliaryAllowed(NSDictionary *container, NSDictionary *frame,
    NSString *type, NSUInteger count, NSUInteger primaryIndex, BOOL *requiresAlpha) {
    if (![type isEqual:@"public.heic"] || count != 1 || primaryIndex != 0
        || container[(NSString *)kCGImagePropertyHEICSDictionary]
        || !SPAuxiliaryAllowed(container, NULL) || !SPAuxiliaryAllowed(frame, NULL)) return NO;
    id hasAlpha = frame[(NSString *)kCGImagePropertyHasAlpha];
    if (!hasAlpha || CFGetTypeID((__bridge CFTypeRef)hasAlpha) != CFBooleanGetTypeID() || ![hasAlpha boolValue]) return NO;
    id width = frame[(NSString *)kCGImagePropertyPixelWidth], height = frame[(NSString *)kCGImagePropertyPixelHeight];
    id orientation = frame[(NSString *)kCGImagePropertyOrientation];
    if (!SPInteger(width, SPMaxDimension) || ![width unsignedIntegerValue]
        || !SPInteger(height, SPMaxDimension) || ![height unsignedIntegerValue]
        || !SPInteger(orientation, 1) || [orientation unsignedIntegerValue] != 1) return NO;
    id contents = container[(NSString *)kCGImagePropertyFileContentsDictionary];
    if (![contents isKindOfClass:NSDictionary.class]) return NO;
    id imageCount = contents[(NSString *)kCGImagePropertyImageCount];
    if (imageCount && (!SPInteger(imageCount, 1) || [imageCount unsignedIntegerValue] != 1)) return NO;
    id images = contents[(NSString *)kCGImagePropertyImages];
    if (![images isKindOfClass:NSArray.class] || [images count] != 1 || ![images[0] isKindOfClass:NSDictionary.class]) return NO;
    id auxiliary = images[0][(NSString *)kCGImagePropertyAuxiliaryData];
    if (![auxiliary isKindOfClass:NSArray.class] || [auxiliary count] != 1) return NO;
    id entry = auxiliary[0];
    NSArray *keys = @[(NSString *)kCGImagePropertyWidth, (NSString *)kCGImagePropertyHeight,
                      (NSString *)kCGImagePropertyOrientation, (NSString *)kCGImagePropertyPixelFormat];
    if (![entry isKindOfClass:NSDictionary.class] || [entry count] != keys.count) return NO;
    for (id key in entry) if (![keys containsObject:key]) return NO;
    id auxiliaryWidth = entry[(NSString *)kCGImagePropertyWidth], auxiliaryHeight = entry[(NSString *)kCGImagePropertyHeight];
    id auxiliaryOrientation = entry[(NSString *)kCGImagePropertyOrientation], pixelFormat = entry[(NSString *)kCGImagePropertyPixelFormat];
    if (!SPInteger(auxiliaryWidth, SPMaxDimension) || ![auxiliaryWidth isEqual:width]
        || !SPInteger(auxiliaryHeight, SPMaxDimension) || ![auxiliaryHeight isEqual:height]
        || !SPInteger(auxiliaryOrientation, 1) || ![auxiliaryOrientation isEqual:orientation]
        || !SPInteger(pixelFormat, UINT32_MAX) || [pixelFormat unsignedIntValue] != kCVPixelFormatType_OneComponent8) return NO;
    if (requiresAlpha) *requiresAlpha = YES;
    return YES;
}

static inline BOOL SPHasAlpha(CGImageRef image) {
    CGImageAlphaInfo alpha = CGImageGetAlphaInfo(image);
    return alpha == kCGImageAlphaPremultipliedLast || alpha == kCGImageAlphaPremultipliedFirst
        || alpha == kCGImageAlphaLast || alpha == kCGImageAlphaFirst || alpha == kCGImageAlphaOnly;
}

// HEICS uses a container frame-info array; per-frame properties can also carry timing.
static inline NSArray<NSNumber *> *SPSequenceTiming(NSDictionary *container, NSArray<NSDictionary *> *frames,
                                                    NSUInteger count, NSNumber **loop) {
    if (loop) *loop = nil;
    if (count < 2 || count > SPMaxFrames || frames.count != count) return nil;
    id sequence = container[(NSString *)kCGImagePropertyHEICSDictionary];
    if (![sequence isKindOfClass:NSDictionary.class] || !SPInteger(sequence[(NSString *)kCGImagePropertyHEICSLoopCount], UINT32_MAX)) return nil;
    id info = sequence[(NSString *)kCGImagePropertyHEICSFrameInfoArray];
    if (info && (![info isKindOfClass:NSArray.class] || [info count] != count)) return nil;
    NSMutableArray *delays = [NSMutableArray new];
    for (NSUInteger index = 0; index < count; index++) {
        id timing = info ? info[index] : frames[index][(NSString *)kCGImagePropertyHEICSDictionary];
        if (![timing isKindOfClass:NSDictionary.class]) return nil;
        id delay = timing[(NSString *)kCGImagePropertyHEICSUnclampedDelayTime] ?: timing[(NSString *)kCGImagePropertyHEICSDelayTime];
        if (!SPNumber(delay) || [delay doubleValue] <= 0 || [delay doubleValue] > 3600) return nil;
        [delays addObject:delay];
    }
    if (loop) *loop = sequence[(NSString *)kCGImagePropertyHEICSLoopCount];
    return delays;
}

static inline BOOL SPFramePropertiesValid(NSArray<NSDictionary *> *frames, BOOL *requiresAlpha, NSString **error) {
    if (!frames.count || frames.count > SPMaxFrames) { if (error) *error = @"image_limits"; return NO; }
    NSUInteger aggregatePixels = 0;
    for (NSDictionary *frame in frames) {
        if (![frame isKindOfClass:NSDictionary.class]) { if (error) *error = @"invalid_image"; return NO; }
        id width = frame[(NSString *)kCGImagePropertyPixelWidth], height = frame[(NSString *)kCGImagePropertyPixelHeight];
        if (!SPInteger(width, SPMaxDimension) || ![width unsignedIntegerValue]
            || !SPInteger(height, SPMaxDimension) || ![height unsignedIntegerValue]) { if (error) *error = @"image_limits"; return NO; }
        NSUInteger pixels = [width unsignedIntegerValue] * [height unsignedIntegerValue];
        if (pixels > SPMaxPixels - aggregatePixels) { if (error) *error = @"image_limits"; return NO; }
        aggregatePixels += pixels;
        if (!SPAuxiliaryAllowed(frame, requiresAlpha)) { if (error) *error = @"unsupported_auxiliary"; return NO; }
        id orientation = frame[(NSString *)kCGImagePropertyOrientation];
        if (orientation && (!SPInteger(orientation, 8) || ![orientation unsignedIntegerValue])) {
            if (error) *error = @"invalid_image"; return NO;
        }
    }
    return YES;
}

@interface SPBoundedSink : NSObject
@property NSMutableData *data;
@property NSUInteger limit;
@property BOOL overflow;
@end
@implementation SPBoundedSink @end

static size_t SPPutBytes(void *info, const void *buffer, size_t count) {
    SPBoundedSink *sink = (__bridge SPBoundedSink *)info;
    if (sink.overflow || count > sink.limit - sink.data.length) { sink.overflow = YES; return 0; }
    [sink.data appendBytes:buffer length:count]; return count;
}

static inline NSData *SPPixels(CGImageRef image) {
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    if (!width || !height || width > SPMaxDimension || height > SPMaxDimension) return nil;
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, width * 4, color,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(color); if (!context) return nil;
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context); return pixels;
}

static inline NSData *SPConvert(NSData *input, NSDictionary **result, NSString **error) {
    if (result) *result = nil; if (error) *error = @"invalid_image";
    if (!input.length || input.length > SPMaxInputBytes) { if (error) *error = @"input_too_large"; return nil; }
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)input, NULL);
    if (!source) return nil;
    CGImageDestinationRef destination = NULL; CGDataConsumerRef consumer = NULL; CGImageSourceRef output = NULL;
    CGImageRef decoded = NULL, normalized = NULL, roundtrip = NULL;
    @try {
        NSString *type = (__bridge NSString *)CGImageSourceGetType(source);
        if (![type isEqual:@"public.heic"] && ![type isEqual:@"public.heics"]) { if (error) *error = @"unsupported_type"; return nil; }
        NSUInteger count = CGImageSourceGetCount(source);
        if (!count || count > SPMaxFrames) { if (error) *error = @"image_limits"; return nil; }
        if (CGImageSourceGetStatus(source) != kCGImageStatusComplete) return nil;
        NSDictionary *container = CFBridgingRelease(CGImageSourceCopyProperties(source, NULL));
        BOOL requiresAlpha = NO, hasAlpha = NO;
        NSMutableArray<NSDictionary *> *properties = [NSMutableArray new];
        for (NSUInteger index = 0; index < count; index++) {
            NSDictionary *frame = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, index, NULL));
            if (!frame) return nil;
            [properties addObject:frame];
        }
        if (!SPFramePropertiesValid(properties, &requiresAlpha, error)) return nil;
        if (!SPContainerAuxiliaryAllowed(container, &requiresAlpha)
            && !SPStaticRasterAuxiliaryAllowed(container, properties[0], type, count,
                CGImageSourceGetPrimaryImageIndex(source), &requiresAlpha)) {
            if (error) *error = @"unsupported_auxiliary"; return nil;
        }
        id sequence = container[(NSString *)kCGImagePropertyHEICSDictionary];
        for (NSString *key in @[(NSString *)kCGImagePropertyHEICSCanvasPixelWidth, (NSString *)kCGImagePropertyHEICSCanvasPixelHeight]) {
            id dimension = [sequence isKindOfClass:NSDictionary.class] ? sequence[key] : nil;
            if (dimension && (!SPInteger(dimension, SPMaxDimension) || ![dimension unsignedIntegerValue])) {
                if (error) *error = @"image_limits"; return nil;
            }
        }
        NSNumber *loop = nil;
        NSArray *delays = count > 1 ? SPSequenceTiming(container, properties, count, &loop) : nil;
        if ((count > 1 && (![type isEqual:@"public.heics"] || !delays))
            || (count == 1 && ([type isEqual:@"public.heics"] || container[(NSString *)kCGImagePropertyHEICSDictionary]))) {
            if (error) *error = @"unsupported_animation"; return nil;
        }
        SPBoundedSink *sink = [SPBoundedSink new]; sink.data = [NSMutableData new]; sink.limit = SPMaxOutputBytes;
        CGDataConsumerCallbacks callbacks = {SPPutBytes, NULL};
        consumer = CGDataConsumerCreate((__bridge void *)sink, &callbacks);
        if (!consumer) { if (error) *error = @"conversion_failed"; return nil; }
        destination = CGImageDestinationCreateWithDataConsumer(consumer, CFSTR("public.png"), count, NULL);
        if (!destination) { if (error) *error = @"conversion_failed"; return nil; }
        if (count > 1) CGImageDestinationSetProperties(destination, (__bridge CFDictionaryRef)@{
            (NSString *)kCGImagePropertyPNGDictionary: @{(NSString *)kCGImagePropertyAPNGLoopCount: loop}});
        NSMutableArray<NSData *> *checks = [NSMutableArray new];
        NSUInteger width = 0, height = 0, decodedPixels = 0;
        for (NSUInteger index = 0; index < count; index++) {
            NSDictionary *frame = properties[index];
            decoded = CGImageSourceCreateImageAtIndex(source, index, (__bridge CFDictionaryRef)@{(NSString *)kCGImageSourceShouldCacheImmediately: @YES});
            if (!decoded || CGImageSourceGetStatusAtIndex(source, index) != kCGImageStatusComplete
                || CGImageSourceGetStatus(source) != kCGImageStatusComplete) return nil;
            NSUInteger w = CGImageGetWidth(decoded), h = CGImageGetHeight(decoded);
            if (!w || !h || w > SPMaxDimension || h > SPMaxDimension || w * h > SPMaxPixels - decodedPixels) {
                if (error) *error = @"image_limits"; return nil;
            }
            decodedPixels += w * h;
            BOOL alpha = SPHasAlpha(decoded);
            if ((requiresAlpha || [frame[(NSString *)kCGImagePropertyHasAlpha] boolValue]) && !alpha) return nil;
            NSUInteger orientation = [frame[(NSString *)kCGImagePropertyOrientation] unsignedIntegerValue] ?: 1;
            if (orientation != 1) {
                normalized = CGImageSourceCreateThumbnailAtIndex(source, index, (__bridge CFDictionaryRef)@{
                    (NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                    (NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
                    (NSString *)kCGImageSourceThumbnailMaxPixelSize: @(MAX(w, h))});
                if (!normalized || CGImageGetWidth(normalized) != (orientation >= 5 ? h : w)
                    || CGImageGetHeight(normalized) != (orientation >= 5 ? w : h)
                    || (alpha && !SPHasAlpha(normalized))) return nil;
            } else normalized = CGImageRetain(decoded);
            w = CGImageGetWidth(normalized); h = CGImageGetHeight(normalized);
            if (index && (w != width || h != height)) { if (error) *error = @"unsupported_animation"; return nil; }
            width = w; height = h; hasAlpha |= alpha;
            NSData *pixels = SPPixels(normalized); if (!pixels) return nil; [checks addObject:pixels];
            NSDictionary *options = count > 1 ? @{
                (NSString *)kCGImagePropertyOrientation: @1,
                (NSString *)kCGImagePropertyPNGDictionary: @{
                    (NSString *)kCGImagePropertyAPNGDelayTime: delays[index],
                    (NSString *)kCGImagePropertyAPNGUnclampedDelayTime: delays[index]}}
                : @{(NSString *)kCGImagePropertyOrientation: @1};
            CGImageDestinationAddImage(destination, normalized, (__bridge CFDictionaryRef)options);
            CGImageRelease(normalized); normalized = NULL; CGImageRelease(decoded); decoded = NULL;
            CGImageSourceRemoveCacheAtIndex(source, index);
        }
        if (!CGImageDestinationFinalize(destination) || sink.overflow || !sink.data.length) {
            if (error) *error = sink.overflow ? @"output_limits" : @"conversion_failed"; return nil;
        }
        output = CGImageSourceCreateWithData((__bridge CFDataRef)sink.data, NULL);
        if (!output || CGImageSourceGetCount(output) != count || CGImageSourceGetStatus(output) != kCGImageStatusComplete) {
            if (error) *error = @"conversion_failed"; return nil;
        }
        if (count > 1) {
            NSDictionary *written = CFBridgingRelease(CGImageSourceCopyProperties(output, NULL));
            id writtenLoop = written[(NSString *)kCGImagePropertyPNGDictionary][(NSString *)kCGImagePropertyAPNGLoopCount];
            if (!SPInteger(writtenLoop, UINT32_MAX) || ![writtenLoop isEqual:loop]) { if (error) *error = @"conversion_failed"; return nil; }
        }
        for (NSUInteger index = 0; index < count; index++) {
            NSDictionary *frame = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(output, index, NULL));
            if (count > 1) {
                id png = frame[(NSString *)kCGImagePropertyPNGDictionary];
                id delay = png[(NSString *)kCGImagePropertyAPNGUnclampedDelayTime] ?: png[(NSString *)kCGImagePropertyAPNGDelayTime];
                if (!SPNumber(delay) || fabs([delay doubleValue] - [delays[index] doubleValue]) > 0.000001) {
                    if (error) *error = @"conversion_failed"; return nil;
                }
            }
            roundtrip = CGImageSourceCreateImageAtIndex(output, index, NULL);
            if (!roundtrip || CGImageSourceGetStatusAtIndex(output, index) != kCGImageStatusComplete
                || CGImageGetWidth(roundtrip) != width || CGImageGetHeight(roundtrip) != height
                || (hasAlpha && !SPHasAlpha(roundtrip)) || ![SPPixels(roundtrip) isEqual:checks[index]]) {
                if (error) *error = @"conversion_failed"; return nil;
            }
            CGImageRelease(roundtrip); roundtrip = NULL;
            CGImageSourceRemoveCacheAtIndex(output, index);
        }
        if (result) *result = @{@"version": @1, @"ok": @YES, @"format": count > 1 ? @"apng" : @"png",
            @"frames": @(count), @"width": @(width), @"height": @(height), @"hasAlpha": @(hasAlpha), @"bytes": @(sink.data.length)};
        if (error) *error = nil; return [sink.data copy];
    } @catch (NSException *exception) {
        (void)exception; if (error) *error = @"conversion_failed"; return nil;
    } @finally {
        if (roundtrip) CGImageRelease(roundtrip);
        if (normalized) CGImageRelease(normalized);
        if (decoded) CGImageRelease(decoded);
        if (output) CFRelease(output);
        if (destination) CFRelease(destination);
        if (consumer) CGDataConsumerRelease(consumer);
        CFRelease(source);
    }
}

static inline BOOL SPPublish(NSData *data, NSString *path) {
    if (!data.length || data.length > SPMaxOutputBytes || !SPPath(path)) return NO;
    int parent = SPDirectory(path.stringByDeletingLastPathComponent, YES);
    if (parent < 0) return NO;
    NSString *temporary = @".bb-sticker-preview.partial";
    int fd = openat(parent, temporary.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) { close(parent); return NO; }
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t count = write(fd, (const unsigned char *)data.bytes + offset, data.length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break; offset += (NSUInteger)count;
    }
    BOOL complete = offset == data.length && !fsync(fd); if (close(fd)) complete = NO;
    // linkat publishes without replacing an existing file or following its symlink.
    BOOL published = complete && !linkat(parent, temporary.fileSystemRepresentation, parent, path.lastPathComponent.fileSystemRepresentation, 0);
    unlinkat(parent, temporary.fileSystemRepresentation, 0); close(parent); return published;
}
