// ==========================================
// Product Gallery - Image Switching
// ==========================================
document.addEventListener('DOMContentLoaded', function() {
    const thumbnails = document.querySelectorAll('.thumbnail-list img');
    const mainImage = document.querySelector('.main-image img');
    
    if (thumbnails.length > 0 && mainImage) {
        thumbnails.forEach(thumbnail => {
            thumbnail.addEventListener('click', function() {
                // Remove active class from all thumbnails
                thumbnails.forEach(thumb => thumb.classList.remove('active'));
                
                // Add active class to clicked thumbnail
                this.classList.add('active');
                
                // Update main image with a smooth transition
                mainImage.style.opacity = '0';
                
                setTimeout(() => {
                    // Get the full-size version of the thumbnail
                    const newImageSrc = this.src.replace('w=200', 'w=800');
                    mainImage.src = newImageSrc;
                    mainImage.alt = this.alt;
                    mainImage.style.opacity = '1';
                }, 200);
            });
        });
    }
});


