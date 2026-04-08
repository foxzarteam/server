# Images Folder

Yahan apni banner images dalo.

## Structure:
```
server/
└── public/
    └── images/
        ├── banner.jpg
        ├── banner2.jpg
        └── ...
```

## Database mein path:
Database ke `banners` table mein `image_url` column mein sirf filename ya relative path dalo:
- `banner.jpg` 
- `images/banner.jpg` (agar subfolder ho)

## Access:
Images automatically serve hongi:
- `http://localhost:3000/images/banner.jpg`
- `http://localhost:3000/images/banner2.jpg`
